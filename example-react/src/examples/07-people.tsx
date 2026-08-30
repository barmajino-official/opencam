import { useState } from 'react';
import { useOpenCamEvent, useOpenCamValue } from '@opencam/client/react';
import { Empty, LiveControls } from '../components/ui';

export const meta = {
  title: 'People tracking',
  blurb: "cam.get('people') — one record per human, with an id that survives frames.",
};

/**
 * `people` fuses the body detection with the face record so one human is one
 * entry, not two. Pairing uses containment rather than IoU: a face box is ~5%
 * of a body box, so their IoU is near zero even for a perfect match.
 *
 * Ids are stable across frames, which is what makes enter/leave expressible.
 */
export default function People() {
  const people = useOpenCamValue('people');
  const [log, setLog] = useState<string[]>([]);

  const push = (line: string) =>
    setLog((previous) => [`${new Date().toLocaleTimeString()}  ${line}`, ...previous].slice(0, 8));

  // These hooks run side effects without re-rendering on every frame.
  useOpenCamEvent('person:enter', (person) =>
    push(`enter  #${person.id}${person.name ? ` (${person.name})` : ''}`),
  );
  useOpenCamEvent('person:leave', (person) => push(`leave  #${person.id}`));
  useOpenCamEvent('face:known', (person) => push(`recognised  ${person.name}`));

  return (
    <div className="space-y-6">
      <LiveControls />

      <div className="card">
        <div className="label mb-2">Tracked people — nearest first</div>
        {people.length === 0 ? (
          <Empty>Nobody on camera.</Empty>
        ) : (
          <div className="space-y-2">
            {people.map((person) => (
              <div key={person.id} className="rounded-lg border border-edge/70 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-200">
                    {person.name && person.name !== 'Unknown' ? person.name : `Person #${person.id}`}
                  </span>
                  <span className="chip">id {person.id}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                  <span>{person.distance_m !== null ? `${person.distance_m} m` : 'distance —'}</span>
                  <span>{person.emotion?.label ?? 'emotion —'}</span>
                  <span>tracked {person.age_s}s</span>
                  <span>{person.has_face ? 'face visible' : 'no face'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="label mb-2">Transitions</div>
        {log.length === 0 ? (
          <Empty>Walk in and out of frame.</Empty>
        ) : (
          <ul className="space-y-1 font-mono text-xs text-slate-400">
            {log.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
