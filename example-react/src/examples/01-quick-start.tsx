import { useOpenCamValue } from '@opencam/client/react';
import { LiveControls, Stat } from '../components/ui';

export const meta = {
  title: 'Quick start',
  blurb: 'The smallest thing that works: go live, read results.',
};

/**
 * Three steps, and the provider in App.tsx already did the first two:
 *
 *   new OpenCam({ sessionId })   construct
 *   await cam.init()             capabilities + metadata socket
 *   await cam.start({...})       acquire media and publish   <- the button
 *
 * After that, `useOpenCamValue(key)` is a live read of the newest inference
 * pass. It never waits: before the first frame you get empty arrays and nulls.
 */
export default function QuickStart() {
  const counts = useOpenCamValue('count');
  const distance = useOpenCamValue('distance');

  return (
    <div className="space-y-6">
      <LiveControls />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Objects" value={counts.objects} />
        <Stat label="People" value={counts.people} />
        <Stat label="Text" value={counts.texts} />
        <Stat label="Distance" value={distance !== null ? `${distance} m` : '—'} />
      </div>

      <p className="text-sm text-slate-400">
        Press <strong className="text-slate-200">Go live</strong>. The browser asks for camera
        access on that click — never on page load, because <code>getUserMedia</code> requires a
        user gesture.
      </p>
    </div>
  );
}
