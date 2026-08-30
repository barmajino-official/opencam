import { useState } from 'react';
import { OpenCamVideo } from '@opencam/client/react';
import { LiveControls } from '../components/ui';

export const meta = {
  title: 'Video modes',
  blurb: 'Clean feed, client overlay, or server-composited pixels.',
};

type Mode = 'clean' | 'overlay' | 'annotated';

/**
 * Three ways to show the same stream, with a real trade-off between them:
 *
 *  clean      the local stream, untouched. Zero added latency.
 *  overlay    same stream + a canvas on top. Still zero added VIDEO latency —
 *             only the JSON round-trips. Layers toggle instantly, client-side.
 *  annotated  a second WebRTC stream where the server already drew the boxes
 *             into the pixels. Costs a decode -> draw -> encode -> decode cycle,
 *             but the annotations survive recording and need no client code.
 *             One render feeds every viewer, so ten watchers cost one pass.
 */
export default function VideoModes() {
  const [mode, setMode] = useState<Mode>('overlay');

  return (
    <div className="space-y-6">
      <LiveControls />

      <div className="flex gap-2">
        {(['clean', 'overlay', 'annotated'] as Mode[]).map((option) => (
          <button
            key={option}
            onClick={() => setMode(option)}
            className={mode === option ? 'btn-primary' : 'btn-ghost'}
          >
            {option}
          </button>
        ))}
      </div>

      {/*
        `key` forces a remount when the mode changes so the component
        renegotiates instead of reusing the previous stream.
      */}
      <OpenCamVideo
        key={mode}
        annotated={mode === 'annotated'}
        overlay={mode === 'overlay'}
        className="overflow-hidden rounded-xl border border-edge bg-black"
        style={{ aspectRatio: '4 / 3' }}
      />

      <div className="card text-sm text-slate-400">
        {mode === 'clean' && 'Local stream, nothing drawn. Lowest possible latency.'}
        {mode === 'overlay' && 'Local stream plus a canvas. Video never leaves the browser.'}
        {mode === 'annotated' &&
          'Server-composited stream. If it stays black, the annotated track only exists while something is publishing — go live first.'}
      </div>
    </div>
  );
}
