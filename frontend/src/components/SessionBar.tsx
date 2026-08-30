import { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '../types';

interface SessionBarProps {
  sessionId: string;
  onSessionChange: (sessionId: string) => void;
  identities: string[];
}

const POLL_INTERVAL_MS = 3000;
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function SessionBar({ sessionId, onSessionChange, identities }: SessionBarProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [draft, setDraft] = useState(sessionId);
  const [reloading, setReloading] = useState(false);

  useEffect(() => setDraft(sessionId), [sessionId]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch('/api/sessions');
        if (!response.ok) return;
        const payload = (await response.json()) as { sessions: SessionSummary[] };
        if (!cancelled) setSessions(payload.sessions);
      } catch {
        /* transient backend restart — the next tick retries */
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (SESSION_PATTERN.test(next) && next !== sessionId) onSessionChange(next);
    else setDraft(sessionId);
  }, [draft, sessionId, onSessionChange]);

  const reloadFaces = useCallback(async () => {
    setReloading(true);
    try {
      await fetch('/api/faces/reload', { method: 'POST' });
    } catch {
      /* surfaced by the identities chip going stale */
    } finally {
      setReloading(false);
    }
  }, []);

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-ink-700 bg-ink-900/80 px-5 py-3 backdrop-blur">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold tracking-tight text-slate-100">OpenCam</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
          realtime vision pipeline
        </span>
      </div>

      <div className="ml-2 flex items-center gap-1.5">
        <label className="text-[10px] uppercase tracking-[0.12em] text-slate-500" htmlFor="session">
          session
        </label>
        <input
          id="session"
          className="field w-44 font-mono"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setDraft(sessionId);
          }}
        />
        <button
          type="button"
          className="btn"
          onClick={() => onSessionChange(`cam-${Math.random().toString(36).slice(2, 8)}`)}
        >
          + new
        </button>
      </div>

      {sessions.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-[0.12em] text-slate-500">active</span>
          {sessions.map((item) => (
            <button
              key={item.session_id}
              type="button"
              onClick={() => onSessionChange(item.session_id)}
              className={`chip transition hover:border-slate-500 ${
                item.session_id === sessionId ? 'border-accent-dim/60 text-accent' : ''
              }`}
              title={`${item.viewers} viewer(s), ${item.subscribers} dashboard(s)`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  item.publishing ? 'bg-accent' : 'bg-slate-600'
                }`}
              />
              {item.session_id}
            </button>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="chip" title={identities.join(', ') || 'no reference faces loaded'}>
          {identities.length} known face{identities.length === 1 ? '' : 's'}
        </span>
        <button type="button" className="btn" onClick={() => void reloadFaces()} disabled={reloading}>
          {reloading ? 'reloading…' : '↻ faces'}
        </button>
      </div>
    </header>
  );
}
