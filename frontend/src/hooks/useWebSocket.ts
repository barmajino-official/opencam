import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Capabilities,
  ConnectionState,
  InferenceMessage,
  LogEvent,
  LogKind,
  ServerMessage,
  SessionSummary,
} from '../types';

const MAX_LOG_EVENTS = 400;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const HEARTBEAT_MS = 15000;

function socketUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/${encodeURIComponent(sessionId)}`;
}

/**
 * Auto-reconnecting metadata socket.
 *
 * The latest inference frame is kept in a ref *and* mirrored to state on a
 * rAF-free cadence: React re-renders at message rate (~15-25 Hz), which is
 * cheap here because the only heavy consumer (the SVG overlay) is memoised on
 * the frame sequence number.
 */
export function useMetadataSocket(sessionId: string, enabled = true) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [inference, setInference] = useState<InferenceMessage | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [identities, setIdentities] = useState<string[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const eventIdRef = useRef(0);
  const closedByUserRef = useRef(false);

  // Deduplication memory for the log console.
  const seenRef = useRef({
    objects: new Set<string>(),
    faces: new Map<string, string>(),
    texts: new Set<string>(),
  });

  const pushEvent = useCallback((kind: LogKind, message: string, detail?: string) => {
    setEvents((previous) => {
      const next: LogEvent = {
        id: eventIdRef.current++,
        kind,
        at: Date.now(),
        message,
        ...(detail !== undefined ? { detail } : {}),
      };
      const merged = [...previous, next];
      return merged.length > MAX_LOG_EVENTS
        ? merged.slice(merged.length - MAX_LOG_EVENTS)
        : merged;
    });
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
    seenRef.current.objects.clear();
    seenRef.current.faces.clear();
    seenRef.current.texts.clear();
  }, []);

  /**
   * Turns a continuous 20 Hz detection stream into discrete, readable log
   * lines: only *transitions* are logged (new class seen, identity changed,
   * new text read), otherwise the console would scroll uselessly fast.
   */
  const deriveEvents = useCallback(
    (message: InferenceMessage) => {
      const seen = seenRef.current;

      for (const item of message.objects) {
        if (item.conf < 0.5 || seen.objects.has(item.label)) continue;
        seen.objects.add(item.label);
        pushEvent('object', `Detected ${item.label}`, `${Math.round(item.conf * 100)}% confidence`);
      }

      for (const face of message.faces) {
        const key = face.box.map((value) => Math.round(value / 48)).join(':');
        const previous = seen.faces.get(key);
        const identity = face.name;
        if (previous !== identity) {
          seen.faces.set(key, identity);
          pushEvent(
            'face',
            identity === 'Unknown' ? 'Unrecognised face' : `Recognised ${identity}`,
            face.similarity !== null ? `similarity ${face.similarity.toFixed(3)}` : undefined,
          );
        }
        if (face.emotion) {
          const emotionKey = `${key}|${face.emotion.label}`;
          if (!seen.texts.has(emotionKey)) {
            seen.texts.add(emotionKey);
            pushEvent(
              'emotion',
              `${identity === 'Unknown' ? 'Face' : identity} looks ${face.emotion.label}`,
              `${Math.round(face.emotion.conf * 100)}%${face.emotion.derived ? ' (derived)' : ''}`,
            );
          }
        }
      }

      for (const item of message.texts) {
        const key = item.text.toLowerCase();
        if (key.length < 2 || seen.texts.has(key)) continue;
        seen.texts.add(key);
        pushEvent('text', `Text: "${item.text}"`, `${Math.round(item.conf * 100)}% confidence`);
      }
    },
    [pushEvent],
  );

  useEffect(() => {
    if (!enabled || !sessionId) {
      setState('idle');
      return;
    }

    closedByUserRef.current = false;
    let disposed = false;

    const clearTimers = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (heartbeatRef.current !== null) window.clearInterval(heartbeatRef.current);
      timerRef.current = null;
      heartbeatRef.current = null;
    };

    const connect = () => {
      if (disposed) return;
      setState(retryRef.current === 0 ? 'connecting' : 'reconnecting');

      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl(sessionId));
      } catch {
        setState('error');
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        retryRef.current = 0;
        setState('connected');
        pushEvent('system', `Metadata stream connected — session "${sessionId}"`);
        heartbeatRef.current = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, HEARTBEAT_MS);
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }

        switch (message.type) {
          case 'inference':
            setInference(message);
            deriveEvents(message);
            break;
          case 'status':
            setSummary(message);
            if (message.publisher) {
              pushEvent('system', `Publisher ${message.publisher}`);
            }
            break;
          case 'hello':
            setCapabilities(message.capabilities);
            setIdentities(message.identities);
            setSummary(message);
            pushEvent(
              'system',
              `Pipeline ready — ${
                Object.entries(message.capabilities)
                  .filter(([, on]) => on)
                  .map(([name]) => name)
                  .join(', ') || 'no stages available'
              }`,
              message.identities.length
                ? `known faces: ${message.identities.join(', ')}`
                : 'no reference faces loaded',
            );
            break;
          case 'pong':
            break;
        }
      };

      socket.onerror = () => {
        if (!disposed) setState('error');
      };

      socket.onclose = () => {
        clearTimers();
        socketRef.current = null;
        if (disposed || closedByUserRef.current) return;

        setState('reconnecting');
        // Exponential backoff, capped — a backend restart should not turn into
        // a reconnect storm from a dozen open dashboards.
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** retryRef.current);
        retryRef.current += 1;
        timerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      closedByUserRef.current = true;
      clearTimers();
      socketRef.current?.close();
      socketRef.current = null;
      setState('closed');
    };
  }, [sessionId, enabled, deriveEvents, pushEvent]);

  return {
    state,
    inference,
    summary,
    capabilities,
    identities,
    events,
    pushEvent,
    clearEvents,
  };
}
