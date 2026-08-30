import { useOpenCamValue } from '@opencam/client/react';
import { OpenCamVideo } from '@opencam/client/react';
import { Empty, LiveControls, Row } from '../components/ui';

export const meta = {
  title: 'Text / OCR',
  blurb: "cam.get('text') — scene text, read on its own cadence.",
};

/**
 * OCR is 5-10x more expensive than the other stages, so it runs on a separate
 * worker at 1/N cadence (OCR_EVERY_N) and its result is carried forward under a
 * TTL. That is why text updates more slowly than boxes — and why a slow text
 * pass can never stall detection.
 *
 * It also runs on the FULL-resolution frame: at 640px, small scene text is
 * already unreadable to the recogniser.
 */
export default function Text() {
  const text = useOpenCamValue('text');
  const texts = useOpenCamValue('texts');

  return (
    <div className="space-y-6">
      <LiveControls />

      <OpenCamVideo
        overlay={{ objects: false, faces: false, texts: true }}
        className="overflow-hidden rounded-xl border border-edge bg-black"
        style={{ aspectRatio: '4 / 3' }}
      />

      <div className="card">
        <div className="label mb-2">Recognised text</div>
        {texts.length === 0 ? (
          <Empty>Hold some printed text up to the camera.</Empty>
        ) : (
          texts.map((item, i) => (
            <Row key={i}>
              <span className="font-mono text-slate-200">{item.text}</span>
              <span className="text-xs text-slate-500">{Math.round(item.conf * 100)}%</span>
            </Row>
          ))
        )}
      </div>

      <div className="card">
        <div className="label mb-1">As plain strings</div>
        <code className="text-sm text-slate-400">{JSON.stringify(text)}</code>
      </div>
    </div>
  );
}
