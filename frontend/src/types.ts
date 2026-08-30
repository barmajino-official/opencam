/**
 * Wire contract with the backend metadata websocket.
 * Mirrors the payload built in backend/pipeline/vision_engine.py::_infer.
 */

/** [x, y, width, height] in source-frame pixels. */
export type Box = [number, number, number, number];
export type Point = [number, number];

export interface DetectedObject {
  label: string;
  class_id: number;
  conf: number;
  box: Box;
}

export interface Emotion {
  label: string;
  conf: number;
  /** true when the label came from the "Thinking" heuristic, not the model head. */
  derived: boolean;
  raw_label: string;
  scores: Record<string, number>;
}

export interface DetectedFace {
  name: string;
  similarity: number | null;
  score: number;
  box: Box;
  landmarks: number[];
  emotion: Emotion | null;
}

export interface DetectedText {
  text: string;
  conf: number;
  box: Box;
  quad: Point[];
}

export interface PipelineStats {
  capture_fps: number;
  inference_fps: number;
  inference_ms: number;
  end_to_end_ms: number;
  ocr_ms: number;
  frames_in: number;
  frames_dropped: number;
  seq: number;
}

export interface Capabilities {
  objects: boolean;
  faces: boolean;
  face_recognition: boolean;
  emotion: boolean;
  ocr: boolean;
}

export interface InferenceMessage {
  type: 'inference';
  session_id: string;
  seq: number;
  ts: number;
  frame: { w: number; h: number };
  objects: DetectedObject[];
  faces: DetectedFace[];
  texts: DetectedText[];
  audio: { level: number };
  latency_ms: number;
  end_to_end_ms: number;
  stats: PipelineStats;
}

export interface SessionSummary {
  session_id: string;
  created_at: number;
  publishing: boolean;
  has_audio: boolean;
  viewers: number;
  subscribers: number;
  idle_s: number;
  stats: PipelineStats;
}

export interface StatusMessage extends SessionSummary {
  type: 'status';
  ts: number;
  publisher?: string;
}

export interface HelloMessage extends SessionSummary {
  type: 'hello';
  capabilities: Capabilities;
  identities: string[];
  ts: number;
}

export interface PongMessage {
  type: 'pong';
  ts: number;
}

export type ServerMessage = InferenceMessage | StatusMessage | HelloMessage | PongMessage;

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error';

export type LogKind = 'object' | 'face' | 'emotion' | 'text' | 'system' | 'error';

export interface LogEvent {
  id: number;
  kind: LogKind;
  at: number;
  message: string;
  detail?: string;
}

export type ViewMode = 'raw' | 'annotated';
