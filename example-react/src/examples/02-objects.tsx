import { useOpenCamValue } from '@opencam/client/react';
import { OpenCamVideo } from '@opencam/client/react';
import { Empty, LiveControls, Row } from '../components/ui';

export const meta = {
  title: 'Object detection',
  blurb: "cam.get('objects') — 80 COCO classes with boxes and distance.",
};

/**
 * `objects` is the raw detector output. Every box is [x, y, w, h] in
 * SOURCE-FRAME pixels; inference runs on a downscaled copy but the backend maps
 * coordinates back before sending, so there is only ever one coordinate system.
 */
export default function Objects() {
  const objects = useOpenCamValue('objects');
  const frame = useOpenCamValue('frame');

  return (
    <div className="space-y-6">
      <LiveControls />

      <OpenCamVideo
        overlay={{ objects: true, faces: false, texts: false }}
        className="overflow-hidden rounded-xl border border-edge bg-black"
        style={{ aspectRatio: '4 / 3' }}
      />

      <div className="card">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">Detections</span>
          <span className="chip">{frame ? `${frame.w}×${frame.h}` : 'no frame'}</span>
        </div>

        {objects.length === 0 ? (
          <Empty>Nothing detected yet.</Empty>
        ) : (
          objects.map((object, i) => (
            <Row key={`${object.label}-${i}`}>
              <span className="font-medium text-slate-200">{object.label}</span>
              <span className="flex items-center gap-3 text-xs text-slate-400">
                <span>{Math.round(object.conf * 100)}%</span>
                {/* Object distance uses a per-class size prior: a hint, not a
                    measurement. `distance_method` says which prior was used. */}
                {object.distance_m !== null && <span>~{object.distance_m} m</span>}
                <code className="text-slate-600">
                  [{object.box.map((n) => Math.round(n)).join(', ')}]
                </code>
              </span>
            </Row>
          ))
        )}
      </div>
    </div>
  );
}
