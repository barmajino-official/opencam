import { useOpenCamValue } from '@opencam/client/react';
import { Empty, LiveControls } from '../components/ui';

export const meta = {
  title: 'Emotion',
  blurb: "cam.get('emotion') — the winning label plus the full distribution.",
};

/**
 * The model has seven real classes: angry, disgust, fear, happy, neutral, sad,
 * surprised. "Thinking" is NOT one of them — a weakly-confident neutral with a
 * pensive runner-up is relabelled and marked `derived: true`. The raw softmax
 * always ships in `scores`, so the heuristic can be ignored entirely
 * (or disabled with EMOTION_THINKING_HEURISTIC=0).
 */
export default function Emotion() {
  const emotion = useOpenCamValue('emotion');

  const scores = Object.entries(emotion?.scores ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <LiveControls />

      {!emotion ? (
        <Empty>No face on camera yet.</Empty>
      ) : (
        <>
          <div className="card">
            <div className="label">Reported</div>
            <div className="flex items-baseline gap-3">
              <span className="value">{emotion.label}</span>
              <span className="text-sm text-slate-400">{Math.round(emotion.conf * 100)}%</span>
              {emotion.derived && (
                <span className="chip border-amber-500/40 text-amber-300">derived</span>
              )}
            </div>
            {emotion.derived && (
              <p className="mt-2 text-xs text-slate-500">
                Heuristic label — the classifier has no such class. See the raw scores below.
              </p>
            )}
          </div>

          <div className="card space-y-2">
            <div className="label">Model distribution</div>
            {scores.map(([name, score]) => (
              <div key={name} className="flex items-center gap-3">
                <span className="w-24 text-sm capitalize text-slate-400">{name}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-edge">
                  <div
                    className="h-full rounded-full bg-sky-500"
                    style={{ width: `${Math.round(score * 100)}%` }}
                  />
                </div>
                <span className="w-12 text-right text-xs tabular-nums text-slate-500">
                  {Math.round(score * 100)}%
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
