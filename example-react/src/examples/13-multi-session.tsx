import { OpenCamProvider, useOpenCamValue, useOpenCamSource } from '@opencam/client/react';
import { Stat } from '../components/ui';
import { BACKEND_URL, SESSION_SUFFIX } from '../session';



export const meta = {
  title: 'Multi-session',
  blurb: 'Independent streams, each with its own ids and telemetry.',
};

/**
 * `sessionId` is the stream identity. Sessions are fully independent: their own
 * peer connections, tracking ids, websocket fan-out and telemetry.
 *
 * What they share is the backend's compute budget — one thread pool. Idle
 * sessions cost nothing; busy ones degrade by dropping more frames rather than
 * thrashing the CPU.
 *
 * Sharing an id is also how you build a viewer: one client publishes, any
 * number call init() without start() and receive the same detections.
 */
function Panel({ sessionId }: { sessionId: string }) {
  const { start, stop, publishing, busy, error } = useOpenCamSource();
  const people = useOpenCamValue('people');
  const counts = useOpenCamValue('count');

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-200">{sessionId}</span>
        <button
          className={publishing ? 'btn-ghost text-xs' : 'btn-primary text-xs'}
          disabled={busy}
          // `audio: false` matters: requesting a microphone that is absent or
          // already held fails the WHOLE getUserMedia call, so the camera never
          // opens and the panel sits silently at publishing=false.
          onClick={() =>
            publishing ? stop() : start({ type: 'camera', audio: false })
          }
        >
          {publishing ? 'Stop' : 'Go live'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="People" value={counts.people} />
        <Stat label="Objects" value={counts.objects} />
      </div>

      <div className="text-xs text-slate-500">
        ids: {people.map((p) => `#${p.id}`).join(' ') || '—'}
      </div>

      {/* Surfacing this is not cosmetic: without it a failed start looks
          identical to an idle panel, which is exactly how the audio bug above
          stayed invisible. */}
      {error && <div className="text-xs text-rose-400">{error.message}</div>}
    </div>
  );
}

export default function MultiSession() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-400">
        Two providers, two session ids, two independent pipelines. Chrome can usually hand the
        same physical camera to both; if the second reports the device is in use, that is the OS
        refusing to share it, not a session problem.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Each provider owns its own OpenCam instance. Remount with `key` to
            change sessionId rather than mutating a live connection. */}
        <OpenCamProvider key="cam-a" url={BACKEND_URL} sessionId={`cam-a-${SESSION_SUFFIX}`}>
          <Panel sessionId={`cam-a-${SESSION_SUFFIX}`} />
        </OpenCamProvider>

        <OpenCamProvider key="cam-b" url={BACKEND_URL} sessionId={`cam-b-${SESSION_SUFFIX}`}>
          <Panel sessionId={`cam-b-${SESSION_SUFFIX}`} />
        </OpenCamProvider>
      </div>
    </div>
  );
}
