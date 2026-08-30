import { useState } from 'react';
import { OpenCamVideo } from '@opencam/client/react';
import { LiveControls } from '../components/ui';

export const meta = {
  title: 'Overlay options',
  blurb: 'Toggle layers, colours and mirroring — all client-side, instantly.',
};

/**
 * The overlay is a canvas painted above the video. It reproduces exactly the
 * letterbox transform that `object-fit: contain` applies, which is what keeps
 * boxes glued to their subjects at any element size. Switch the video to
 * `cover` and the boxes drift — the fit function has to match the CSS.
 *
 * Toggling a layer is pure client state: no renegotiation, no server round trip.
 */
export default function Overlay() {
  const [objects, setObjects] = useState(true);
  const [faces, setFaces] = useState(true);
  const [texts, setTexts] = useState(true);
  const [distance, setDistance] = useState(true);
  const [labels, setLabels] = useState(true);
  const [mirrored, setMirrored] = useState(false);

  const toggles = [
    ['Objects', objects, setObjects],
    ['Faces', faces, setFaces],
    ['Text', texts, setTexts],
    ['Distance', distance, setDistance],
    ['Labels', labels, setLabels],
    ['Mirror', mirrored, setMirrored],
  ] as const;

  return (
    <div className="space-y-6">
      <LiveControls />

      <div className="flex flex-wrap gap-2">
        {toggles.map(([label, value, set]) => (
          <button
            key={label}
            onClick={() => set(!value)}
            className={value ? 'btn-primary' : 'btn-ghost'}
          >
            {label}
          </button>
        ))}
      </div>

      <OpenCamVideo
        mirrored={mirrored}
        overlay={{
          objects,
          faces,
          texts,
          distance,
          labels,
          colors: { object: '#38bdf8', face: '#4ade80', text: '#fbbf24' },
        }}
        className="overflow-hidden rounded-xl border border-edge bg-black"
        style={{ aspectRatio: '4 / 3' }}
      />

      <p className="text-sm text-slate-400">
        Mirroring flips the geometry but keeps label text readable — the plates are drawn
        unmirrored on purpose.
      </p>
    </div>
  );
}
