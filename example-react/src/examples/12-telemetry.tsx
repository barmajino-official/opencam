import { useOpenCam, useOpenCamValue } from '@opencam/client/react';
import { LiveControls, Stat } from '../components/ui';

export const meta = {
  title: 'Telemetry',
  blurb: "cam.get('stats') — and why a huge dropped-frame count is correct.",
};

const BUDGET_MS = 150;

/**
 * The number that matters is `end_to_end_ms`: capture to metadata.
 *
 * `frames_dropped` climbing fast is the design working, not a fault. The
 * pipeline keeps a single-slot register rather than a queue — a new frame
 * overwrites whatever is pending — so worst-case lag is one inference pass
 * forever. A FIFO would instead grow lag without bound the moment inference is
 * slower than the camera.
 */
export default function Telemetry() {
  const stats = useOpenCamValue('stats');
  const { capabilities } = useOpenCam();

  const tone = (ms: number) =>
    ms > 300 ? 'text-rose-400' : ms > BUDGET_MS ? 'text-amber-400' : 'text-emerald-400';

  const dropRate =
    stats && stats.frames_in > 0 ? Math.round((stats.frames_dropped / stats.frames_in) * 100) : 0;

  return (
    <div className="space-y-6">
      <LiveControls />

      {!stats ? (
        <p className="text-sm text-slate-500">Go live to collect telemetry.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={`End-to-end (budget ${BUDGET_MS}ms)`}
              value={`${stats.end_to_end_ms}ms`}
              tone={tone(stats.end_to_end_ms)}
            />
            <Stat label="Model" value={`${stats.inference_ms}ms`} />
            <Stat label="Capture" value={`${stats.capture_fps} fps`} />
            <Stat label="Inference" value={`${stats.inference_fps} fps`} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="OCR pass" value={`${stats.ocr_ms}ms`} />
            <Stat label="Frames in" value={stats.frames_in} />
            <Stat label="Dropped" value={`${dropRate}%`} />
            <Stat label="Sequence" value={stats.seq} />
          </div>

          <div className="card text-sm text-slate-400">
            Dropping {dropRate}% of frames is expected: the camera produces{' '}
            {stats.capture_fps} fps and inference sustains {stats.inference_fps} fps, so the rest
            are deliberately skipped to keep latency bounded.
          </div>
        </>
      )}

      <div className="card">
        <div className="label mb-2">Loaded stages</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(capabilities ?? {}).map(([name, on]) => (
            <span
              key={name}
              className={`chip ${on ? 'border-emerald-500/40 text-emerald-300' : 'text-slate-600'}`}
            >
              {name} {on ? '✓' : '✗'}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          A stage whose model failed to load reports <code>false</code> instead of crashing the
          backend — always feature-detect rather than assuming.
        </p>
      </div>
    </div>
  );
}
