import { useState } from 'react';
import { useOpenCam, useOpenCamValue } from '@opencam/client/react';
import type { OpenCamKey } from '@opencam/client';
import { LiveControls } from '../components/ui';

export const meta = {
  title: 'Snapshot inspector',
  blurb: 'Every get() key, live. The wire format with nothing hidden.',
};

const KEYS: OpenCamKey[] = [
  'objects', 'faces', 'people', 'text', 'texts', 'distance',
  'emotion', 'names', 'audio', 'stats', 'frame', 'count', 'raw',
];

/**
 * `get(key)` is typed per key through a value map, so `get('distance')` is
 * `number | null` while `get('objects')` is `DetectedObject[]` — one signature,
 * per-key return types, autocomplete on the string literal.
 *
 * This page just walks every key so you can see the real shapes.
 */
export default function Inspector() {
  const [key, setKey] = useState<OpenCamKey>('people');
  const value = useOpenCamValue(key);
  const { cam } = useOpenCam();

  return (
    <div className="space-y-6">
      <LiveControls />

      <div className="flex flex-wrap gap-2">
        {KEYS.map((option) => (
          <button
            key={option}
            onClick={() => setKey(option)}
            className={key === option ? 'btn-primary text-xs' : 'btn-ghost text-xs'}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-edge">
        <div className="flex items-center justify-between bg-panel px-4 py-2">
          <code className="text-sm text-sky-300">cam.get('{key}')</code>
          <span className="chip">
            {Array.isArray(value) ? `${value.length} items` : typeof value}
          </span>
        </div>
        <pre className="max-h-96 overflow-auto bg-[#0a0e13] p-4 text-xs leading-relaxed text-slate-300">
          {JSON.stringify(value, null, 2)}
        </pre>
      </div>

      <div className="card space-y-2 text-sm text-slate-400">
        <div className="label">Query helpers</div>
        <div className="font-mono text-xs">
          <div>cam.has('person') → {String(cam.has('person'))}</div>
          <div>cam.find('person').length → {cam.find('person').length}</div>
          <div>cam.nearest()?.id → {String(cam.nearest()?.id ?? null)}</div>
          <div>cam.isPresent('barmajino') → {String(cam.isPresent('barmajino'))}</div>
        </div>
      </div>
    </div>
  );
}
