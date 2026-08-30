import type { ReactNode } from 'react';
import { EXAMPLES } from '../registry';

/** Sidebar menu plus content area. Pure layout, no OpenCam knowledge. */
export function Shell({
  current,
  onNavigate,
  children,
}: {
  current: string;
  onNavigate: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full">
      <nav className="hidden w-72 shrink-0 flex-col border-r border-edge bg-panel/40 md:flex">
        <div className="border-b border-edge px-5 py-4">
          <h1 className="text-lg font-semibold text-slate-100">OpenCam</h1>
          <p className="text-xs text-slate-500">React examples</p>
        </div>

        <ul className="flex-1 overflow-y-auto p-2">
          {EXAMPLES.map((example, index) => {
            const active = example.id === current;
            return (
              <li key={example.id}>
                <button
                  onClick={() => onNavigate(example.id)}
                  className={`w-full rounded-lg px-3 py-2 text-left transition ${
                    active ? 'bg-sky-500/15 text-sky-300' : 'text-slate-300 hover:bg-edge/50'
                  }`}
                >
                  <span className="mr-2 text-[11px] tabular-nums text-slate-600">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="text-sm font-medium">{example.title}</span>
                  <span className="mt-0.5 block pl-7 text-xs leading-snug text-slate-500">
                    {example.blurb}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-edge px-5 py-3 text-[11px] leading-relaxed text-slate-600">
          Start the backend with <code className="text-slate-400">docker compose up -d</code>.
          This app calls it cross-origin, so its origin must be in
          <code className="text-slate-400"> CORS_ALLOW_ORIGINS</code>.
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

/** Mobile fallback: the sidebar is hidden, so expose a plain select. */
export function MobilePicker({
  current,
  onNavigate,
}: {
  current: string;
  onNavigate: (id: string) => void;
}) {
  return (
    <select
      value={current}
      onChange={(event) => onNavigate(event.target.value)}
      className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm md:hidden"
    >
      {EXAMPLES.map((example) => (
        <option key={example.id} value={example.id}>
          {example.title}
        </option>
      ))}
    </select>
  );
}
