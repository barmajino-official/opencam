/**
 * The OpenCam client.
 *
 * Lifecycle is deliberately three explicit steps rather than one magic
 * constructor:
 *
 *   const cam = new OpenCam({ url, sessionId });  // cheap, no I/O
 *   await cam.init();                             // capabilities + metadata socket
 *   await cam.start({ type: 'camera' });          // permission prompt + publish
 *
 * `init()` is separated from `start()` because a dashboard often wants to read
 * an existing session's metadata without publishing anything, and because the
 * camera permission prompt must be triggered by a user gesture — folding it
 * into construction would make that impossible to control.
 */

import { drawSnapshot } from './overlay.js';
import { exchangeSdp } from './signalling.js';
import { MetadataSocket } from './socket.js';
import { EMPTY_SNAPSHOT, select, snapshotFrom } from './snapshot.js';
import { resolveSource, type ResolvedSource } from './sources.js';
import type {
  Capabilities,
  ConnectionState,
  DetectedObject,
  OpenCamConfig,
  OpenCamEventMap,
  OpenCamKey,
  OpenCamValueMap,
  OverlayOptions,
  Person,
  ServerConfig,
  ServerMessage,
  Snapshot,
  Source,
  Unsubscribe,
  VideoOptions,
} from './types.js';

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

type Listener = (payload: never) => void;

export class OpenCam {
  readonly sessionId: string;
  readonly baseUrl: string;

  private readonly iceServers: RTCIceServer[];
  private readonly reconnect: boolean;
  private readonly autoConnect: boolean;
  private readonly debug: boolean;
  private readonly token: string | null;

  private socket: MetadataSocket | null = null;
  private snapshot: Snapshot = EMPTY_SNAPSHOT;
  private listeners = new Map<string, Set<Listener>>();

  private publisherPc: RTCPeerConnection | null = null;
  private publisherResource: string | null = null;
  private resolved: ResolvedSource | null = null;
  private localStream: MediaStream | null = null;

  private viewerPc: RTCPeerConnection | null = null;
  private viewerResource: string | null = null;
  private viewerStream: MediaStream | null = null;
  private viewerAnnotated = true;

  private ingestUrl: string | null = null;
  /**
   * Whether the *server* currently has a publisher for this session.
   *
   * Distinct from `isPublishing`, which is only about this client. A viewer
   * needs the remote answer, and "a frame arrived once" is not it — inference
   * frames outlive the publisher that produced them, so using them as the
   * signal makes a viewer negotiate for a track that has already gone.
   */
  private remotePublishing = false;

  private serverConfig: ServerConfig | null = null;
  private connection: ConnectionState = 'idle';

  /** Ids seen in the previous frame, for enter/leave edge detection. */
  private previousIds = new Set<number>();
  private announcedNames = new Set<string>();

  constructor(config: OpenCamConfig = {}) {
    const origin =
      config.url ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8080');
    // Trailing slashes turn `${base}/api/x` into `//api/x`, which some proxies
    // treat as a protocol-relative URL. Strip once, here.
    this.baseUrl = origin.replace(/\/+$/, '');
    this.sessionId = config.sessionId ?? 'default';
    this.iceServers = config.iceServers ?? DEFAULT_ICE;
    this.reconnect = config.reconnect ?? true;
    this.autoConnect = config.autoConnect ?? true;
    this.debug = config.debug ?? false;
    this.token = config.token ?? null;
  }

  /** Auth header for REST/WHIP calls; empty when no token is configured. */
  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.authHeaders(), ...(init.headers ?? {}) },
    });
  }

  // -- lifecycle ----------------------------------------------------------

  /**
   * Fetch server capabilities and (unless `autoConnect: false`) open the
   * metadata socket. Safe to call more than once.
   */
  async init(): Promise<ServerConfig> {
    const response = await this.request('/api/config');
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(
          'OpenCam rejected the request (401). The backend has OPENCAM_API_TOKEN set; ' +
            'pass a matching `token` in the client config.',
        );
      }
      throw new Error(
        `cannot reach the OpenCam backend at ${this.baseUrl} (${response.status}). ` +
          'Check the url option, and that CORS_ALLOW_ORIGINS includes this origin.',
      );
    }
    this.serverConfig = (await response.json()) as ServerConfig;
    if (this.autoConnect) this.connect();
    return this.serverConfig;
  }

  /** Open the metadata websocket without publishing anything. */
  connect(): void {
    if (this.socket) return;
    // The token rides in the query string because the WebSocket handshake
    // cannot carry an Authorization header from a browser.
    const suffix = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const wsUrl =
      `${this.baseUrl.replace(/^http/, 'ws')}/ws/${encodeURIComponent(this.sessionId)}${suffix}`;
    this.socket = new MetadataSocket(
      wsUrl,
      {
        onMessage: (message) => this.handleMessage(message),
        onState: (state) => {
          this.connection = state;
          this.emit('connection', state);
        },
        onError: (error) => this.emit('error', error),
      },
      this.reconnect,
    );
    this.socket.start();
  }

  /** Begin publishing `source` into this session. */
  async start(source: Source = { type: 'camera' }): Promise<MediaStream | null> {
    await this.stop();
    if (!this.serverConfig) await this.init();
    else if (this.autoConnect) this.connect();

    const resolved = await resolveSource(source);
    this.resolved = resolved;

    if (resolved.serverIngest) {
      await this.startServerIngest(resolved.serverIngest);
      return null;
    }

    if (!resolved.stream) throw new Error('source produced no media stream');
    this.localStream = resolved.stream;
    await this.publish(resolved.stream);
    return resolved.stream;
  }

  private async startServerIngest(ingest: {
    url: string;
    loop: boolean;
    rtspTransport: string;
    audio: boolean;
    format?: string;
  }): Promise<void> {
    const response = await this.request(
      `/api/ingest/${encodeURIComponent(this.sessionId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ingest.url,
          loop: ingest.loop,
          rtsp_transport: ingest.rtspTransport,
          audio: ingest.audio,
          ...(ingest.format ? { format: ingest.format } : {}),
        }),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`ingest failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    this.ingestUrl = ingest.url;
    this.log('server ingest started', ingest.url);
  }

  private async publish(stream: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.publisherPc = pc;

    pc.addEventListener('connectionstatechange', () => {
      this.log('publisher connection', pc.connectionState);
      if (pc.connectionState === 'failed') {
        // 'failed' covers two very different causes and the message used to
        // assert the wrong one: ICE genuinely failing, and the server dropping
        // us because another client published to the same session (a new WHIP
        // offer replaces the existing publisher).
        this.emit(
          'error',
          new Error(
            `publisher connection lost for session '${this.sessionId}' - either ICE could ` +
              'not establish, or another client published to the same session and replaced it.',
          ),
        );
      }
    });

    // recvonly transceivers up front so the m-line order in our offer is
    // stable and the answer always matches, regardless of track arrival order.
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    await pc.setLocalDescription(await pc.createOffer());
    const { answer, resource } = await exchangeSdp(
      pc,
      `${this.baseUrl}/api/whip/${encodeURIComponent(this.sessionId)}`,
      undefined,
      this.authHeaders(),
    );
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    this.publisherResource = resource;
    this.log('publishing');
  }

  /** Stop publishing. Leaves the metadata socket open. */
  async stop(): Promise<void> {
    const pc = this.publisherPc;
    this.publisherPc = null;
    this.remotePublishing = false;

    if (this.ingestUrl) {
      this.ingestUrl = null;
      await this.request(`/api/ingest/${encodeURIComponent(this.sessionId)}`, {
        method: 'DELETE',
      }).catch(() => undefined);
    }

    if (pc) {
      pc.getSenders().forEach((sender) => sender.track?.stop());
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    }
    if (this.publisherResource) {
      await fetch(this.publisherResource, {
        method: 'DELETE', headers: this.authHeaders(),
      }).catch(() => undefined);
      this.publisherResource = null;
    }

    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.resolved?.cleanup?.();
    this.resolved = null;

    await this.stopViewer();
  }

  /**
   * Stop publishing and close the metadata socket.
   *
   * The instance stays reusable: calling `init()` again reconnects. That is not
   * a nicety — React StrictMode deliberately mounts, unmounts and remounts every
   * effect in development, so a provider's cleanup runs against an instance that
   * is about to be used again.
   *
   * Listeners are deliberately NOT cleared here. They belong to whoever
   * registered them, and each subscriber removes its own on unmount. Clearing
   * them centrally silently unsubscribed every live hook — the UI then froze on
   * whatever it had last rendered while the backend kept streaming happily.
   */
  async destroy(): Promise<void> {
    await this.stop();
    this.socket?.stop();
    this.socket = null;
    this.snapshot = EMPTY_SNAPSHOT;
  }

  // -- reading results ----------------------------------------------------

  /**
   * Read one field of the latest inference pass.
   *
   * Always returns immediately from the last received frame; it never waits for
   * a new one. Before the first frame arrives you get empty arrays and `null`s,
   * never `undefined`, so callers do not need existence checks.
   *
   * @example
   * cam.get('objects')   // DetectedObject[]
   * cam.get('distance')  // number | null - metres to the nearest person
   * cam.get('people')    // Person[] - nearest first, with stable ids
   * cam.get('text')      // string[]
   */
  get<K extends OpenCamKey>(key: K): OpenCamValueMap[K] {
    return select(this.snapshot, key);
  }

  /** The whole latest snapshot. Reference-stable between frames. */
  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  /** `true` if any object with this label is currently visible. */
  has(label: string): boolean {
    const needle = label.toLowerCase();
    return this.snapshot.objects.some((o) => o.label.toLowerCase() === needle);
  }

  /** Every detection matching `label`, strongest confidence first. */
  find(label: string): DetectedObject[] {
    const needle = label.toLowerCase();
    return this.snapshot.objects
      .filter((o) => o.label.toLowerCase() === needle)
      .sort((a, b) => b.conf - a.conf);
  }

  /** The closest tracked person, or `null` when nobody is visible. */
  nearest(): Person | null {
    return this.snapshot.people[0] ?? null;
  }

  /** Look up a tracked person by the stable id from `get('people')`. */
  person(id: number): Person | null {
    return this.snapshot.people.find((p) => p.id === id) ?? null;
  }

  /** `true` when this gallery identity is currently on camera. */
  isPresent(name: string): boolean {
    const needle = name.toLowerCase();
    return this.snapshot.people.some((p) => p.name?.toLowerCase() === needle);
  }

  get capabilities(): Capabilities | null {
    return this.serverConfig?.capabilities ?? null;
  }

  get identities(): string[] {
    return this.serverConfig?.identities ?? [];
  }

  get connectionState(): ConnectionState {
    return this.connection;
  }

  get isPublishing(): boolean {
    return this.publisherPc !== null || this.ingestUrl !== null;
  }

  /** True when there is any video to show: ours, or someone else's. */
  get hasSource(): boolean {
    return this.isPublishing || this.remotePublishing;
  }

  /** Re-scan the backend's `/faces` directory for newly added photos. */
  async reloadFaces(): Promise<string[]> {
    const response = await this.request('/api/faces/reload', { method: 'POST' });
    if (!response.ok) throw new Error(`face reload failed (${response.status})`);
    const body = (await response.json()) as { identities?: string[] };
    if (this.serverConfig && body.identities) this.serverConfig.identities = body.identities;
    return body.identities ?? [];
  }

  // -- video --------------------------------------------------------------

  /**
   * Get a playable `MediaStream` for this session.
   *
   * `{ annotated: false }` (the default) is the clean feed: for a browser
   * source that is the local stream, so it costs nothing and adds no latency.
   * `{ annotated: true }` negotiates a second WebRTC connection and returns the
   * server-composited stream with boxes and labels burned into the pixels —
   * one extra decode/draw/encode cycle, but the annotations survive recording
   * and need no overlay on the client.
   */
  async getVideo(options: VideoOptions = {}): Promise<MediaStream> {
    const annotated = options.annotated ?? false;

    if (!annotated && this.localStream) return this.localStream;

    // No local copy and nothing publishing: a viewer negotiation would just
    // time out. Fail fast with a message that says what to do instead.
    if (!this.hasSource) {
      throw new Error(
        `session '${this.sessionId}' has no video yet - call start() first, ` +
          'or wait for a publisher to join.',
      );
    }

    if (this.viewerStream && this.viewerAnnotated === annotated) return this.viewerStream;
    await this.stopViewer();
    this.viewerAnnotated = annotated;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.viewerPc = pc;

    const remote = new MediaStream();
    const ready = new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for the remote track')),
        10000,
      );
      pc.addEventListener('track', (event) => {
        remote.addTrack(event.track);
        if (event.track.kind === 'video') {
          clearTimeout(timer);
          resolve(remote);
        }
      });
    });

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    await pc.setLocalDescription(await pc.createOffer());

    const endpoint = `${this.baseUrl}/api/watch/${encodeURIComponent(this.sessionId)}${
      annotated ? '' : '?annotated=0'
    }`;
    const { answer, resource } = await exchangeSdp(pc, endpoint, undefined, this.authHeaders());
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    this.viewerResource = resource;

    this.viewerStream = await ready;
    return this.viewerStream;
  }

  private async stopViewer(): Promise<void> {
    const pc = this.viewerPc;
    this.viewerPc = null;
    this.viewerStream = null;
    if (pc) {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    }
    if (this.viewerResource) {
      await fetch(this.viewerResource, {
        method: 'DELETE', headers: this.authHeaders(),
      }).catch(() => undefined);
      this.viewerResource = null;
    }
  }

  /**
   * Keep `canvas` painted with the latest detections, aligned to `video`.
   *
   * The canvas must be positioned exactly over the video element and the video
   * must use `object-fit: contain` — the overlay reproduces that specific
   * letterbox transform. Returns a detach function.
   */
  attachOverlay(
    canvas: HTMLCanvasElement,
    options: OverlayOptions = {},
  ): Unsubscribe {
    let frame = 0;
    const paint = () => {
      drawSnapshot(canvas, this.snapshot, options);
    };
    const unsubscribe = this.on('update', () => {
      // Coalesce into the next paint: detections arrive at up to 25 Hz, and
      // drawing more often than the compositor refreshes is wasted work.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    });
    paint();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }

  // -- events -------------------------------------------------------------

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof OpenCamEventMap>(
    event: K,
    listener: (payload: OpenCamEventMap[K]) => void,
  ): Unsubscribe {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener as Listener);
    return () => {
      bucket!.delete(listener as Listener);
    };
  }

  /** Subscribe, then unsubscribe automatically after the first call. */
  once<K extends keyof OpenCamEventMap>(
    event: K,
    listener: (payload: OpenCamEventMap[K]) => void,
  ): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  private emit<K extends keyof OpenCamEventMap>(event: K, payload: OpenCamEventMap[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    for (const listener of Array.from(bucket)) {
      try {
        (listener as (p: OpenCamEventMap[K]) => void)(payload);
      } catch (error) {
        // One bad subscriber must not stop the others, and must not kill the
        // socket read loop that got us here.
        console.error(`[opencam] listener for '${String(event)}' threw:`, error);
      }
    }
  }

  private handleMessage(message: ServerMessage): void {
    if (message.type === 'hello' || message.type === 'status') {
      // Both carry the session's `publishing` flag; `hello` gives a viewer the
      // current state immediately instead of waiting for the next heartbeat.
      const publishing = (message as { publishing?: unknown }).publishing;
      if (typeof publishing === 'boolean') this.remotePublishing = publishing;
      if (message.type === 'status') this.emit('status', message);
      return;
    }
    if (message.type !== 'inference') return;

    const snapshot = snapshotFrom(message);
    this.snapshot = snapshot;

    this.emit('update', snapshot);
    this.emit('objects', snapshot.objects);
    this.emit('faces', snapshot.faces);
    this.emit('people', snapshot.people);
    if (snapshot.texts.length) this.emit('text', snapshot.texts.map((t) => t.text));

    this.detectTransitions(snapshot);
  }

  /**
   * Turn the per-frame people list into enter/leave edges.
   *
   * Done client-side rather than on the backend because "left" is a judgement
   * about a time window, and different consumers want different windows. The
   * backend's tracker already absorbs the short gaps caused by dropped frames,
   * so an id disappearing here really does mean the person is gone.
   */
  private detectTransitions(snapshot: Snapshot): void {
    const current = new Set<number>();

    for (const person of snapshot.people) {
      current.add(person.id);
      if (!this.previousIds.has(person.id)) this.emit('person:enter', person);

      const name = person.name;
      if (name && name !== 'Unknown' && !this.announcedNames.has(name)) {
        this.announcedNames.add(name);
        this.emit('face:known', person);
      }
    }

    for (const id of this.previousIds) {
      if (current.has(id)) continue;
      this.emit('person:leave', { id } as Person);
      const gone = snapshot.people.find((p) => p.id === id)?.name;
      if (gone) this.announcedNames.delete(gone);
    }

    // Names go stale once nobody is on camera, so a person who leaves and comes
    // back triggers `face:known` again rather than staying silent forever.
    if (snapshot.people.length === 0) this.announcedNames.clear();

    this.previousIds = current;
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.debug('[opencam]', ...args);
  }
}

/** Convenience: construct, init and start in one call. */
export async function createOpenCam(
  config: OpenCamConfig & { source?: Source | false } = {},
): Promise<OpenCam> {
  const { source, ...rest } = config;
  const cam = new OpenCam(rest);
  await cam.init();
  if (source !== false) await cam.start(source ?? { type: 'camera' });
  return cam;
}
