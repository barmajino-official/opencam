import { useState } from 'react';
import { useOpenCamEvent } from '@opencam/client/react';
import { Empty, LiveControls } from '../components/ui';

export const meta = {
  title: 'Events',
  blurb: 'Push instead of poll — including transitions the raw frames do not give you.',
};

interface Entry {
  at: string;
  kind: string;
  detail: string;
}

/**
 * `useOpenCamEvent` runs a callback WITHOUT re-rendering, which is what you
 * want for side effects — logging, toasts, triggering a request.
 *
 * `person:enter` / `person:leave` / `face:known` are edges derived from the
 * tracker. The backend already absorbs the short gaps caused by dropped frames,
 * so a leave really means the person is gone, not that one frame missed them.
 */
export default function Events() {
  const [entries, setEntries] = useState<Entry[]>([]);

  const push = (kind: string, detail: string) =>
    setEntries((previous) =>
      [{ at: new Date().toLocaleTimeString(), kind, detail }, ...previous].slice(0, 40),
    );

  useOpenCamEvent('person:enter', (p) => push('person:enter', `#${p.id} at ${p.distance_m ?? '?'} m`));
  useOpenCamEvent('person:leave', (p) => push('person:leave', `#${p.id}`));
  useOpenCamEvent('face:known', (p) => push('face:known', p.name ?? '?'));
  useOpenCamEvent('text', (lines) => push('text', lines.join(' · ')));
  useOpenCamEvent('connection', (state) => push('connection', state));
  useOpenCamEvent('error', (error) => push('error', error.message));

  const colour = (kind: string) =>
    kind === 'error' ? 'text-rose-400'
    : kind.startsWith('person') ? 'text-sky-300'
    : kind === 'face:known' ? 'text-emerald-300'
    : 'text-slate-500';

  return (
    <div className="space-y-6">
      <LiveControls />

      <div className="card">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">Event stream</span>
          <button className="btn-ghost text-xs" onClick={() => setEntries([])}>Clear</button>
        </div>

        {entries.length === 0 ? (
          <Empty>Go live, then move in and out of frame.</Empty>
        ) : (
          <ul className="max-h-96 space-y-1 overflow-y-auto font-mono text-xs">
            {entries.map((entry, i) => (
              <li key={i} className="flex gap-3">
                <span className="text-slate-600">{entry.at}</span>
                <span className={`w-28 shrink-0 ${colour(entry.kind)}`}>{entry.kind}</span>
                <span className="text-slate-400">{entry.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-sm text-slate-400">
        Note that <code>update</code> is deliberately not logged here — it fires up to 25 times a
        second and would drown everything else.
      </p>
    </div>
  );
}
