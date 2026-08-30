/**
 * Reconnecting metadata websocket.
 *
 * Backoff is exponential with jitter. Without jitter, every client that dropped
 * during a backend restart reconnects on the same tick and stampedes the
 * process that just came back up.
 */

import type { ConnectionState, ServerMessage } from './types.js';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const HEARTBEAT_MS = 15000;

export interface SocketHandlers {
  onMessage: (message: ServerMessage) => void;
  onState: (state: ConnectionState) => void;
  onError: (error: Error) => void;
}

export class MetadataSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private readonly url: string,
    private readonly handlers: SocketHandlers,
    private readonly reconnect = true,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Reset the backoff: a socket restarted after an explicit stop is a fresh
    // connection, not a continuation of an earlier failure streak.
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Drop handlers before closing: otherwise `onclose` schedules a reconnect
      // for a socket we deliberately tore down.
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
    this.handlers.onState('closed');
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(payload: unknown): void {
    if (this.isOpen) {
      try {
        this.ws!.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      } catch {
        /* the close handler will deal with it */
      }
    }
  }

  private clearTimers(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.retry !== null) clearTimeout(this.retry);
    this.heartbeat = null;
    this.retry = null;
  }

  private open(): void {
    if (this.stopped) return;
    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (error) {
      this.handlers.onError(error as Error);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onState('connected');
      this.heartbeat = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS);
    };

    ws.onmessage = (event) => {
      try {
        this.handlers.onMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        /* a malformed frame is not worth tearing the socket down for */
      }
    };

    ws.onerror = () => {
      // The browser gives no detail here by design; `onclose` carries the code.
      this.handlers.onState('error');
    };

    ws.onclose = () => {
      this.clearTimers();
      this.ws = null;
      if (!this.stopped) this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (!this.reconnect || this.stopped) {
      this.handlers.onState('closed');
      return;
    }
    const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.attempt);
    const jitter = backoff * 0.3 * Math.random();
    this.attempt += 1;
    this.handlers.onState('reconnecting');
    this.retry = setTimeout(() => this.open(), backoff + jitter);
  }
}
