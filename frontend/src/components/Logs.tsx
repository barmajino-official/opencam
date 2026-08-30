import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEvent, LogKind } from '../types';

interface LogsProps {
  events: LogEvent[];
  onClear: () => void;
}

const KIND_STYLE: Record<LogKind, { badge: string; text: string; label: string }> = {
  object: { badge: 'bg-sky-500/15 text-sky-300', text: 'text-slate-300', label: 'OBJ' },
  face: { badge: 'bg-emerald-500/15 text-emerald-300', text: 'text-slate-200', label: 'FACE' },
  emotion: { badge: 'bg-violet-500/15 text-violet-300', text: 'text-slate-300', label: 'EMO' },
  text: { badge: 'bg-amber-500/15 text-amber-300', text: 'text-slate-300', label: 'OCR' },
  system: { badge: 'bg-slate-500/15 text-slate-400', text: 'text-slate-500', label: 'SYS' },
  error: { badge: 'bg-rose-500/15 text-rose-300', text: 'text-rose-300', label: 'ERR' },
};

const FILTERS: Array<{ key: LogKind | 'all'; label: string }> = [
  { key: 'all', label: 'all' },
  { key: 'face', label: 'faces' },
  { key: 'emotion', label: 'emotions' },
  { key: 'object', label: 'objects' },
  { key: 'text', label: 'ocr' },
  { key: 'system', label: 'system' },
];

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function Logs({ events, onClear }: LogsProps) {
  const [filter, setFilter] = useState<LogKind | 'all'>('all');
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => (filter === 'all' ? events : events.filter((event) => event.kind === filter)),
    [events, filter],
  );

  useEffect(() => {
    if (!follow) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [visible, follow]);

  return (
    <div className="panel flex min-h-0 flex-1 flex-col">
      <div className="panel-header">
        <span className="panel-title">Detection log</span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-slate-500">
            <input
              type="checkbox"
              className="accent-accent-dim"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            follow
          </label>
          <button type="button" className="btn px-2 py-1" onClick={onClear}>
            clear
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-ink-700 px-3 py-2">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={`rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition ${
              filter === item.key
                ? 'bg-accent-dim/20 text-accent'
                : 'text-slate-500 hover:bg-ink-800 hover:text-slate-300'
            }`}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto self-center font-mono text-[10px] text-slate-600">
          {visible.length} / {events.length}
        </span>
      </div>

      <div
        ref={scrollRef}
        // Detach scroll-follow the moment the operator scrolls up to read
        // something — nothing is more annoying than a log that fights you.
        onWheel={(event) => {
          if (event.deltaY < 0) setFollow(false);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {visible.length === 0 ? (
          <p className="py-6 text-center text-slate-700">no events yet</p>
        ) : (
          visible.map((event) => {
            const style = KIND_STYLE[event.kind];
            return (
              <div key={event.id} className="flex items-start gap-2 py-[3px]">
                <span className="shrink-0 text-slate-700">{formatTime(event.at)}</span>
                <span className={`shrink-0 rounded px-1 text-[9px] leading-4 ${style.badge}`}>
                  {style.label}
                </span>
                <span className={`min-w-0 break-words ${style.text}`}>
                  {event.message}
                  {event.detail && <span className="ml-1.5 text-slate-600">({event.detail})</span>}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
