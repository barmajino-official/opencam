/**
 * The OpenCam wire contract.
 *
 * Every geometric value crossing the wire is in **source-frame pixels** with the
 * origin at the top-left, expressed as `[x, y, width, height]`. Inference runs
 * on a downscaled copy of the frame, but the backend maps every coordinate back
 * before publishing, so consumers only ever deal with one coordinate system:
 * the one described by `Snapshot.frame`.
 *
 * These declarations mirror the backend's payload construction in
 * `backend/pipeline/vision_engine.py`. The two are one contract in two
 * languages with nothing mechanical enforcing their agreement — change both.
 */

/** `[x, y, width, height]` in source-frame pixels. */
export type Box = [number, number, number, number];

/** Model-reported emotion. `Thinking` is derived, not predicted — see `derived`. */
export interface Emotion {
  /** `Happy | Sad | Angry | Neutral | Surprised | Disgust | Fearful | Thinking`. */
  label: string;
  /** Confidence of the winning class, 0..1. */
  conf: number;
  /**
   * `true` when the label came from a heuristic rather than the classifier.
   * Only `Thinking` is ever derived: the FER model has no such class, so a
   * weakly-confident `neutral` with a pensive runner-up is relabelled. Read
   * `scores` instead if you want the raw model distribution.
   */
  derived: boolean;
  /** Full softmax over the model's seven real classes. */
  scores: Record<string, number>;
}

export interface DetectedObject {
  /** COCO class name, e.g. `person`, `laptop`, `cell phone`. */
  label: string;
  class_id: number;
  /** Detector confidence, 0..1. */
  conf: number;
  box: Box;
  /**
   * Coarse distance in metres from a per-class size prior, or `null` when the
   * class has no usable prior. Treat as an order-of-magnitude hint only.
   */
  distance_m: number | null;
  distance_method: 'class_prior' | null;
}

export interface DetectedFace {
  /** Matched identity from the faces gallery, or `"Unknown"`. */
  name: string;
  /** Cosine similarity to the best gallery match, or `null` if unmatched. */
  similarity: number | null;
  /** Face-detector confidence. */
  score: number;
  box: Box;
  /** Flat `[x,y] * 5`: right eye, left eye, nose, right mouth, left mouth. */
  landmarks: number[];
  emotion: Emotion | null;
  /** Distance in metres. `ipd` is accurate to roughly ±10% once calibrated. */
  distance_m: number | null;
  distance_method: 'ipd' | 'face_width' | null;
}

/** One human, fusing a body detection with a face record where both exist. */
export interface Person {
  /** Stable across frames for as long as the person is tracked. */
  id: number;
  /** Seconds since this id was first assigned. */
  age_s: number;
  /** Best available box: the body when known, otherwise the face. */
  box: Box;
  body_box: Box | null;
  face_box: Box | null;
  /** Recognised identity, `"Unknown"`, or `null` when no face was seen. */
  name: string | null;
  similarity: number | null;
  emotion: Emotion | null;
  /** Metres. Face-derived when a face is visible, else the body-height prior. */
  distance_m: number | null;
  distance_method: string | null;
  confidence: number;
  has_face: boolean;
}

export interface DetectedText {
  text: string;
  conf: number;
  box: Box;
  /** Rotated quadrilateral `[[x,y] * 4]` when the text is not axis-aligned. */
  quad?: number[][];
}

export interface PipelineStats {
  capture_fps: number;
  inference_fps: number;
  inference_ms: number;
  end_to_end_ms: number;
  ocr_ms: number;
  frames_in: number;
  /** Expected to be large. The pipeline drops frames by design — see README. */
  frames_dropped: number;
  seq: number;
}

export interface FrameSize {
  w: number;
  h: number;
}

/** Which pipeline stages actually loaded. A missing model yields `false`. */
export interface Capabilities {
  objects: boolean;
  faces: boolean;
  face_recognition: boolean;
  emotion: boolean;
  ocr: boolean;
}

export interface ServerConfig {
  capabilities: Capabilities;
  identities: string[];
  inference: {
    max_side: number;
    min_interval_ms: number;
    ocr_every_n: number;
    max_workers: number;
  };
  distance: { enabled: boolean; camera_hfov_deg: number; ipd_m: number };
  people: { enabled: boolean };
  ingest: { enabled: boolean; allowed_schemes: string[] };
}

/** One inference pass, as broadcast on the metadata websocket. */
export interface InferenceMessage {
  type: 'inference';
  session_id: string;
  seq: number;
  ts: number;
  frame: FrameSize;
  objects: DetectedObject[];
  faces: DetectedFace[];
  people: Person[];
  texts: DetectedText[];
  audio: { level: number };
  latency_ms: number;
  end_to_end_ms: number;
  stats: PipelineStats;
}

export interface StatusMessage {
  type: 'status';
  session_id: string;
  publisher?: string;
  source?: string;
  source_url?: string | null;
  publishing?: boolean;
  viewers?: number;
  [key: string]: unknown;
}

export type ServerMessage =
  | InferenceMessage
  | StatusMessage
  | { type: 'hello'; [key: string]: unknown }
  | { type: 'pong'; [key: string]: unknown };

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error';

/** Immutable view of the most recent inference pass. */
export interface Snapshot {
  seq: number;
  /** `Date.now()`-style epoch ms when this snapshot was received. */
  receivedAt: number;
  frame: FrameSize | null;
  objects: DetectedObject[];
  faces: DetectedFace[];
  people: Person[];
  texts: DetectedText[];
  audioLevel: number;
  stats: PipelineStats | null;
  /** Age of the snapshot in ms. Recomputed on read, not stored. */
  latencyMs: number;
}

/**
 * Key -> return-type map for {@link OpenCam.get}.
 *
 * Adding a key here automatically gives `get()` the right return type and the
 * right autocomplete, with no overload to maintain.
 */
export interface OpenCamValueMap {
  /** Everything the object detector saw this frame. */
  objects: DetectedObject[];
  /** Raw face records (one per detected face, not deduplicated into people). */
  faces: DetectedFace[];
  /** One entry per human, with a stable `id`. Sorted nearest-first. */
  people: Person[];
  /** Alias of `people`, for readability. */
  persons: Person[];
  /** Recognised text as plain strings, in reading order. */
  text: string[];
  /** Full text records with geometry and confidence. */
  texts: DetectedText[];
  /** Metres to the nearest tracked person, or `null` if nobody is visible. */
  distance: number | null;
  /** Emotion of the nearest person, or `null`. */
  emotion: Emotion | null;
  /** Names of everyone currently recognised (excludes `"Unknown"`). */
  names: string[];
  /** Microphone level, 0..1. `0` when the source has no audio. */
  audio: number;
  /** Throughput and latency telemetry, or `null` before the first frame. */
  stats: PipelineStats | null;
  /** Source frame dimensions, or `null` before the first frame. */
  frame: FrameSize | null;
  /** Cheap cardinalities without materialising the arrays. */
  count: { objects: number; people: number; faces: number; texts: number };
  /** The whole snapshot, if you would rather destructure it yourself. */
  raw: Snapshot;
}

export type OpenCamKey = keyof OpenCamValueMap;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Local webcam. Triggers the browser permission prompt. */
export interface CameraSource {
  type: 'camera';
  /** Exact device from `navigator.mediaDevices.enumerateDevices()`. */
  deviceId?: string;
  width?: number;
  height?: number;
  fps?: number;
  audio?: boolean;
  facingMode?: 'user' | 'environment';
  /** Escape hatch: replaces everything above. */
  constraints?: MediaStreamConstraints;
}

/** Screen / window / tab capture. Triggers the browser picker. */
export interface ScreenSource {
  type: 'screen';
  audio?: boolean;
}

/** A `MediaStream` you already own (another library, a canvas, a peer). */
export interface StreamSource {
  type: 'stream';
  stream: MediaStream;
}

/** An existing `<video>` element, captured via `captureStream()`. */
export interface ElementSource {
  type: 'element';
  element: HTMLVideoElement;
}

/** A local file from an `<input type="file">` or a drop event. */
export interface FileSource {
  type: 'file';
  file: File | Blob;
  loop?: boolean;
  muted?: boolean;
}

/**
 * A URL.
 *
 * `mode: 'browser'` plays it in a hidden `<video>` and publishes the captured
 * stream — works for anything the browser can play (mp4, webm, HLS in Safari)
 * and requires permissive CORS on the media host.
 *
 * `mode: 'server'` hands the URL to the backend, which opens it with ffmpeg.
 * This is the only option for `rtsp://` and the right one for IP cameras, since
 * no browser can play RTSP and the credentials never reach the client.
 *
 * Defaults to `'server'` for `rtsp://` and `rtmp://`, `'browser'` otherwise.
 */
export interface UrlSource {
  type: 'url';
  url: string;
  mode?: 'browser' | 'server';
  loop?: boolean;
  /** Server mode only. TCP avoids the packet loss that shreds UDP RTSP. */
  rtspTransport?: 'tcp' | 'udp';
  audio?: boolean;
  /** Server mode only: force an ffmpeg demuxer, e.g. `'mjpeg'`. */
  format?: string;
}

export type Source =
  | CameraSource
  | ScreenSource
  | StreamSource
  | ElementSource
  | FileSource
  | UrlSource;

// ---------------------------------------------------------------------------
// Config & events
// ---------------------------------------------------------------------------

export interface OpenCamConfig {
  /**
   * Backend origin, e.g. `http://localhost:8081`. Defaults to the page origin,
   * which is correct when a reverse proxy fronts `/api` and `/ws` (as the
   * bundled nginx does).
   */
  url?: string;
  /** Stream identity. Two clients sharing one id share the stream. */
  sessionId?: string;
  /** ICE servers for the WebRTC legs. Add TURN for cross-network use. */
  iceServers?: RTCIceServer[];
  /** Open the metadata socket during `init()`. Default `true`. */
  autoConnect?: boolean;
  /** Reconnect the metadata socket on drop. Default `true`. */
  reconnect?: boolean;
  /** Console diagnostics. Default `false`. */
  debug?: boolean;
  /**
   * Bearer token, when the backend sets `OPENCAM_API_TOKEN`.
   *
   * Sent as `Authorization: Bearer <token>` on REST and WHIP calls, and as a
   * `?token=` query parameter on the metadata websocket — browsers cannot set
   * headers on a WebSocket handshake. Because it appears in a URL there, treat
   * it as a session-scoped secret: it can land in proxy and server logs.
   */
  token?: string;
}

export interface VideoOptions {
  /**
   * `true` returns the server-composited stream with boxes and labels burned
   * into the pixels. `false` (default) returns the clean feed.
   */
  annotated?: boolean;
}

export interface OverlayOptions {
  objects?: boolean;
  faces?: boolean;
  people?: boolean;
  texts?: boolean;
  /** Draw `1.42m` next to each box when a distance is known. Default `true`. */
  distance?: boolean;
  /** Draw class/identity labels. Default `true`. */
  labels?: boolean;
  /** Mirror horizontally to match a CSS-flipped selfie view. Default `false`. */
  mirrored?: boolean;
  lineWidth?: number;
  font?: string;
  colors?: Partial<Record<'object' | 'face' | 'person' | 'text', string>>;
}

export interface OpenCamEventMap {
  /** Fires once per inference pass, after the snapshot is committed. */
  update: Snapshot;
  objects: DetectedObject[];
  faces: DetectedFace[];
  people: Person[];
  text: string[];
  /** A tracked person id appeared. */
  'person:enter': Person;
  /** A tracked person id vanished for good. */
  'person:leave': Person;
  /** A gallery identity became visible (fires once per appearance). */
  'face:known': Person;
  status: StatusMessage;
  connection: ConnectionState;
  error: Error;
}

export type Unsubscribe = () => void;
