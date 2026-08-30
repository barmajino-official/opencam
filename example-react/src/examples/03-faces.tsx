import { useState } from 'react';
import { useOpenCam, useOpenCamValue } from '@opencam/client/react';
import { OpenCamVideo } from '@opencam/client/react';
import { Empty, LiveControls, Row } from '../components/ui';

export const meta = {
  title: 'Face recognition',
  blurb: "cam.get('faces') plus the /faces gallery and a live reload.",
};

/**
 * Identity comes from matching a face embedding against photos in the
 * backend's `/faces` directory. The filename is the label:
 * `faces/Ali_Jaafar.png` -> "Ali Jaafar". Unmatched faces are "Unknown" —
 * still detected, still tracked, still given a distance and an emotion.
 */
export default function Faces() {
  const { cam, identities } = useOpenCam();
  const faces = useOpenCamValue('faces');
  const [reloaded, setReloaded] = useState<string[] | null>(null);

  return (
    <div className="space-y-6">
      <LiveControls />

      <OpenCamVideo
        overlay={{ objects: false, faces: true, texts: false }}
        mirrored
        className="overflow-hidden rounded-xl border border-edge bg-black"
        style={{ aspectRatio: '4 / 3' }}
      />

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="label">Known identities</span>
          <button
            className="btn-ghost text-xs"
            onClick={async () => setReloaded(await cam.reloadFaces())}
          >
            ↻ Rescan /faces
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(reloaded ?? identities).map((name) => (
            <span key={name} className="chip text-slate-300">{name}</span>
          ))}
          {(reloaded ?? identities).length === 0 && (
            <span className="text-sm text-slate-500">
              No reference photos. Drop one into <code>faces/</code> and rescan.
            </span>
          )}
        </div>
      </div>

      <div className="card">
        <div className="label mb-2">Faces on camera</div>
        {faces.length === 0 ? (
          <Empty>No face detected.</Empty>
        ) : (
          faces.map((face, i) => (
            <Row key={i}>
              <span
                className={
                  face.name === 'Unknown'
                    ? 'font-medium text-slate-400'
                    : 'font-medium text-emerald-300'
                }
              >
                {face.name}
              </span>
              <span className="flex gap-3 text-xs text-slate-400">
                {/* Cosine similarity against the gallery. The default match
                    threshold is 0.363 — above it, the name is accepted. */}
                {face.similarity !== null && <span>sim {face.similarity}</span>}
                {face.distance_m !== null && <span>{face.distance_m} m</span>}
                {face.emotion && <span>{face.emotion.label}</span>}
              </span>
            </Row>
          ))
        )}
      </div>
    </div>
  );
}
