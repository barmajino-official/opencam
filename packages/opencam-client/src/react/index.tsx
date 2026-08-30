/**
 * React bindings.
 *
 * The design goal is that a component re-renders only when the field it
 * actually reads changes. `useOpenCam()` gives you the instance and coarse
 * connection state without subscribing to frames at all; `useOpenCamValue(key)`
 * subscribes to exactly one field. Reading `distance` in a component does not
 * re-render it when only OCR text changed.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { OpenCam } from '../opencam.js';
import { select } from '../snapshot.js';
import type {
  Capabilities,
  ConnectionState,
  OpenCamConfig,
  OpenCamEventMap,
  OpenCamKey,
  OpenCamValueMap,
  OverlayOptions,
  Snapshot,
  Source,
} from '../types.js';

/**
 * Per-snapshot memo of derived values.
 *
 * `useSyncExternalStore` compares the result of `getSnapshot()` with
 * `Object.is`, so a selector that builds a new array every call would loop
 * forever. Snapshots are frozen and swapped wholesale, which makes the snapshot
 * reference an exact cache key; the WeakMap lets superseded snapshots be
 * collected without any bookkeeping.
 */
const derivedCache = new WeakMap<Snapshot, Map<string, unknown>>();

function selectStable<K extends OpenCamKey>(snapshot: Snapshot, key: K): OpenCamValueMap[K] {
  let bucket = derivedCache.get(snapshot);
  if (!bucket) {
    bucket = new Map();
    derivedCache.set(snapshot, bucket);
  }
  if (!bucket.has(key)) bucket.set(key, select(snapshot, key));
  return bucket.get(key) as OpenCamValueMap[K];
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface OpenCamContextValue {
  cam: OpenCam;
  /** `true` once `/api/config` has been read successfully. */
  ready: boolean;
  error: Error | null;
  capabilities: Capabilities | null;
  identities: string[];
}

const OpenCamContext = createContext<OpenCamContextValue | null>(null);

export interface OpenCamProviderProps extends OpenCamConfig {
  children: ReactNode;
  /** Publish this source as soon as the provider is ready. */
  autoStart?: Source | false;
  /** Reuse an instance you constructed yourself instead of creating one. */
  client?: OpenCam;
}

export function OpenCamProvider({
  children,
  autoStart = false,
  client,
  ...config
}: OpenCamProviderProps) {
  // Config is read once. Changing `url` or `sessionId` after mount should
  // remount the provider (give it a `key`) rather than silently re-negotiating
  // a live connection underneath the children.
  const camRef = useRef<OpenCam | null>(null);
  if (camRef.current === null) camRef.current = client ?? new OpenCam(config);
  const cam = camRef.current;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [identities, setIdentities] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    cam
      .init()
      .then(async (serverConfig) => {
        if (cancelled) return;
        setCapabilities(serverConfig.capabilities);
        setIdentities(serverConfig.identities);
        setReady(true);
        if (autoStart) await cam.start(autoStart);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause);
      });

    const offError = cam.on('error', setError);
    return () => {
      cancelled = true;
      offError();
      // Only tear down an instance we own. A caller-supplied `client` may well
      // outlive this provider.
      if (!client) void cam.destroy();
    };
  }, [cam, client, autoStart]);

  const value = useMemo<OpenCamContextValue>(
    () => ({ cam, ready, error, capabilities, identities }),
    [cam, ready, error, capabilities, identities],
  );

  return <OpenCamContext.Provider value={value}>{children}</OpenCamContext.Provider>;
}

/** Access the client and its coarse state. Does not re-render per frame. */
export function useOpenCam(): OpenCamContextValue {
  const context = useContext(OpenCamContext);
  if (!context) throw new Error('useOpenCam must be used inside <OpenCamProvider>');
  return context;
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

/**
 * Subscribe to one field of the live inference stream.
 *
 * @example
 * const objects  = useOpenCamValue('objects');
 * const distance = useOpenCamValue('distance');
 * const people   = useOpenCamValue('people');
 */
export function useOpenCamValue<K extends OpenCamKey>(key: K): OpenCamValueMap[K] {
  const { cam } = useOpenCam();

  const subscribe = useCallback(
    (notify: () => void) => cam.on('update', notify),
    [cam],
  );
  const getSnapshot = useCallback(
    () => selectStable(cam.getSnapshot(), key),
    [cam, key],
  );

  // Server render has no websocket; fall back to the same empty snapshot the
  // client starts from so hydration does not mismatch.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The whole snapshot. Re-renders on every inference pass — use sparingly. */
export function useOpenCamSnapshot(): Snapshot {
  const { cam } = useOpenCam();
  const subscribe = useCallback((notify: () => void) => cam.on('update', notify), [cam]);
  const getSnapshot = useCallback(() => cam.getSnapshot(), [cam]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether this session currently has *any* video to show — either we are
 * publishing locally, or a remote publisher is feeding the session.
 *
 * `<OpenCamVideo>` needs this: asking for a stream before a publisher exists
 * negotiates a viewer for a track that is not there, which fails with a
 * timeout and, worse, never retries once someone does go live.
 */
export function useOpenCamHasVideo(): boolean {
  const { cam } = useOpenCam();

  const subscribe = useCallback(
    (notify: () => void) => {
      const offStatus = cam.on('status', notify);
      const offUpdate = cam.on('update', notify);
      return () => {
        offStatus();
        offUpdate();
      };
    },
    [cam],
  );

  // `hasSource` combines our own publishing state with the server's reported
  // one, so a viewer-only client still gets a stream — and, crucially, a client
  // holding a stale snapshot from a publisher that has gone does not.
  const getSnapshot = useCallback(() => cam.hasSource, [cam]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Websocket connection state, for status indicators. */
export function useOpenCamConnection(): ConnectionState {
  const { cam } = useOpenCam();
  const subscribe = useCallback((notify: () => void) => cam.on('connection', notify), [cam]);
  const getSnapshot = useCallback(() => cam.connectionState, [cam]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Run a callback on an OpenCam event without re-rendering.
 *
 * The handler is stored in a ref so an inline arrow function does not
 * resubscribe on every render.
 */
export function useOpenCamEvent<K extends keyof OpenCamEventMap>(
  event: K,
  handler: (payload: OpenCamEventMap[K]) => void,
): void {
  const { cam } = useOpenCam();
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(
    () => cam.on(event, (payload) => ref.current(payload)),
    [cam, event],
  );
}

/** Imperative publish controls plus live publishing state. */
export function useOpenCamSource() {
  const { cam } = useOpenCam();
  const [publishing, setPublishing] = useState(cam.isPublishing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const start = useCallback(
    async (source?: Source) => {
      setBusy(true);
      setError(null);
      try {
        const stream = await cam.start(source ?? { type: 'camera' });
        setPublishing(true);
        return stream;
      } catch (cause) {
        setError(cause as Error);
        setPublishing(false);
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [cam],
  );

  const stop = useCallback(async () => {
    await cam.stop();
    setPublishing(false);
  }, [cam]);

  return { start, stop, publishing, busy, error };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface OpenCamVideoProps {
  /** Show the server-composited stream with annotations burned in. */
  annotated?: boolean;
  /** Draw boxes on a canvas above the video (zero added video latency). */
  overlay?: boolean | OverlayOptions;
  /** Mirror horizontally, as expected of a selfie view. */
  mirrored?: boolean;
  muted?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onError?: (error: Error) => void;
}

/**
 * A `<video>` wired to the session, optionally with a detection overlay.
 *
 * `object-fit: contain` is not a style choice — the overlay reproduces exactly
 * that letterbox transform to place boxes. Overriding it to `cover` will make
 * the boxes drift away from their subjects.
 */
export function OpenCamVideo({
  annotated = false,
  overlay = false,
  mirrored = false,
  muted = true,
  className,
  style,
  onError,
}: OpenCamVideoProps) {
  const { cam, ready } = useOpenCam();
  const hasVideo = useOpenCamHasVideo();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // `hasVideo` gates this, and is also what re-runs it: mounting before a
    // publisher exists used to negotiate a viewer for a missing track, time
    // out, and then sit blank forever because nothing retried on go-live.
    if (!ready || !hasVideo) return;
    let cancelled = false;

    cam
      .getVideo({ annotated })
      .then((stream) => {
        if (cancelled || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        return videoRef.current.play().catch(() => undefined);
      })
      .catch((cause: Error) => {
        if (!cancelled) onError?.(cause);
      });

    return () => {
      cancelled = true;
    };
  }, [cam, ready, hasVideo, annotated, onError]);

  const overlayOptions = useMemo<OverlayOptions | null>(() => {
    if (!overlay) return null;
    return { mirrored, ...(typeof overlay === 'object' ? overlay : {}) };
  }, [overlay, mirrored]);

  useEffect(() => {
    if (!overlayOptions || !canvasRef.current) return;
    return cam.attachOverlay(canvasRef.current, overlayOptions);
  }, [cam, overlayOptions]);

  return (
    <div style={{ position: 'relative', ...style }} className={className}>
      <video
        ref={videoRef}
        muted={muted}
        playsInline
        autoPlay
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          objectFit: 'contain',
          transform: mirrored ? 'scaleX(-1)' : undefined,
        }}
      />
      {overlayOptions ? (
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </div>
  );
}
