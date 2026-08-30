import { useState } from 'react';
import { useOpenCamValue } from '@opencam/client/react';
import { LiveControls, Stat } from '../components/ui';

export const meta = {
  title: 'Distance',
  blurb: "cam.get('distance') — metres to the nearest person, and how to calibrate it.",
};

/**
 * A single camera has no inherent scale, so distance comes from a metric prior
 * plugged into the pinhole model:
 *
 *   distance = (real_size_m * focal_px) / apparent_size_px
 *   focal_px = (frame_width / 2) / tan(hfov / 2)
 *
 * Faces use interpupillary distance (~63 mm, tight variance across adults) and
 * are good to roughly +-10% once the lens angle is right. Objects use per-class
 * height priors and are order-of-magnitude hints only.
 */
export default function Distance() {
  const distance = useOpenCamValue('distance');
  const people = useOpenCamValue('people');
  const [actual, setActual] = useState('1.0');

  const nearest = people[0];
  // Every estimate scales linearly with the assumed field of view, so a single
  // measurement at a known distance is enough to solve for the real one.
  const CURRENT_HFOV = 60;
  const suggested =
    distance !== null && Number(actual) > 0
      ? (
          (2 *
            Math.atan(
              Math.tan((CURRENT_HFOV / 2) * (Math.PI / 180)) * (distance / Number(actual)),
            ) *
            180) /
          Math.PI
        ).toFixed(1)
      : null;

  return (
    <div className="space-y-6">
      <LiveControls />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Nearest person"
          value={distance !== null ? `${distance} m` : '—'}
          tone={distance !== null && distance < 0.4 ? 'text-amber-400' : ''}
        />
        <Stat label="Method" value={nearest?.distance_method ?? '—'} />
        <Stat label="People" value={people.length} />
      </div>

      <div className="card space-y-3">
        <div className="label">Calibrate</div>
        <p className="text-sm text-slate-400">
          Sit at a measured distance, type it below, and use the suggested field of view.
          Uncalibrated, the trend is right but the absolute value can be 30% out.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-slate-400">
            Real distance (m)
            <input
              value={actual}
              onChange={(event) => setActual(event.target.value)}
              className="ml-2 w-24 rounded-lg border border-edge bg-ink px-2 py-1 text-slate-200"
            />
          </label>
          {suggested && (
            <code className="rounded-lg bg-ink px-3 py-1.5 text-sm text-emerald-300">
              CAMERA_HFOV_DEG={suggested}
            </code>
          )}
        </div>
        <p className="text-xs text-slate-500">
          Put that in <code>.env</code>, then <code>docker compose up -d</code>.
        </p>
      </div>
    </div>
  );
}
