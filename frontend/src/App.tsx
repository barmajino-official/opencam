import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasOverlay } from './components/CanvasOverlay';
import { Logs } from './components/Logs';
import { SessionBar } from './components/SessionBar';
import { StatsBar } from './components/StatsBar';
import { Streamer } from './components/Streamer';
import { Viewer } from './components/Viewer';
import { useMetadataSocket } from './hooks/useWebSocket';
import type { ViewMode } from './types';

const DEFAULT_SESSION = 'cam-01';

/** Session id lives in the URL hash so a dashboard is shareable and reloadable. */
function readSessionFromHash(): string {
  const hash = window.location.hash.replace(/^#\/?/, '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(hash) ? hash : DEFAULT_SESSION;
}

export default function App() {
  const [sessionId, setSessionId] = useState<string>(readSessionFromHash);
  const [mode, setMode] = useState<ViewMode>('raw');
  const [mirrored, setMirrored] = useState(false);
  const [showObjects, setShowObjects] = useState(true);
  const [showFaces, setShowFaces] = useState(true);
  const [showTexts, setShowTexts] = useState(true);

  const { state, inference, capabilities, identities, events, clearEvents } =
    useMetadataSocket(sessionId);

  useEffect(() => {
    window.location.hash = `/${sessionId}`;
  }, [sessionId]);

  useEffect(() => {
    const onHashChange = () => setSessionId(readSessionFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Held in a ref so handleSessionChange keeps a stable identity even though
  // clearEvents is re-created whenever the socket hook re-renders.
  const clearEventsRef = useRef(clearEvents);
  clearEventsRef.current = clearEvents;

  const handleSessionChange = useCallback((next: string) => {
    setSessionId(next);
    // Metadata and media are per-session; the log would otherwise mix streams.
    clearEventsRef.current();
  }, []);

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <SessionBar
        sessionId={sessionId}
        onSessionChange={handleSessionChange}
        identities={identities}
      />

      <main className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(360px,1fr)] xl:overflow-hidden">
        <section className="flex min-h-0 flex-col gap-4 xl:overflow-y-auto xl:pr-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-ink-600 bg-ink-800 p-0.5">
              {(['raw', 'annotated'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                    mode === value
                      ? 'bg-accent-dim/20 text-accent'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {value === 'raw' ? 'Raw feed + overlay' : 'Server rendered'}
                </button>
              ))}
            </div>

            <span className="text-[11px] text-slate-600">
              {mode === 'raw'
                ? 'local video, boxes drawn client-side — zero added video latency'
                : 'annotations baked in by the backend, audio relayed'}
            </span>

            <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-400">
              {(
                [
                  ['objects', showObjects, setShowObjects],
                  ['faces', showFaces, setShowFaces],
                  ['ocr', showTexts, setShowTexts],
                ] as const
              ).map(([label, value, setter]) => (
                <label key={label} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    className="accent-accent-dim"
                    checked={value}
                    disabled={mode === 'annotated'}
                    onChange={(event) => setter(event.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/*
            The streamer stays mounted in both modes: unmounting it would tear
            down the publishing PeerConnection, which is the thing feeding the
            annotated track the viewer is watching.
          */}
          <div className={mode === 'annotated' ? 'hidden' : undefined}>
            <Streamer
              sessionId={sessionId}
              mirrored={mirrored}
              onMirroredChange={setMirrored}
            >
              <CanvasOverlay
                result={inference}
                showObjects={showObjects}
                showFaces={showFaces}
                showTexts={showTexts}
                mirrored={mirrored}
              />
            </Streamer>
          </div>

          {mode === 'annotated' && (
            <>
              <Viewer sessionId={sessionId} enabled={mode === 'annotated'} />
              <div className="panel px-4 py-3 text-[11px] text-slate-500">
                The camera keeps publishing in the background. Switch back to
                <span className="mx-1 font-mono text-slate-400">Raw feed + overlay</span>
                to control it.
              </div>
            </>
          )}

          <StatsBar inference={inference} capabilities={capabilities} socketState={state} />
        </section>

        <section className="flex min-h-0 flex-col gap-4 xl:overflow-hidden">
          <Logs events={events} onClear={clearEvents} />
        </section>
      </main>
    </div>
  );
}
