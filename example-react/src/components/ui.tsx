import type { ReactNode } from 'react';
import { useOpenCam, useOpenCamConnection, useOpenCamSource } from '@opencam/client/react';
import type { Source } from '@opencam/client';

/**
 * Small presentational helpers shared by the examples, so each example file
 * stays focused on the one OpenCam idea it is demonstrating.
 */

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-500">{children}</p>;
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-edge/60 py-2 last:border-0">
      {children}
    </div>
  );
}

/**
 * Go-live controls.
 *
 * `start()` is called from a click because browsers only grant camera access
 * inside a user gesture — this is why the SDK separates `init()` from
 * `start()` instead of doing both on mount.
 */
export function LiveControls({ source }: { source?: Source }) {
  // `audio: false` by default: no example uses the microphone, and asking for
  // one that is absent or already in use fails the WHOLE getUserMedia call with
  // NotFoundError -- taking the camera down with it.
  const { ready, error: initError } = useOpenCam();
  const { start, stop, publishing, busy, error } = useOpenCamSource();
  const connection = useOpenCamConnection();

  const dot =
    connection === 'connected' ? 'bg-emerald-400'
    : connection === 'connecting' || connection === 'reconnecting' ? 'bg-amber-400'
    : 'bg-slate-600';

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        className={publishing ? 'btn-ghost' : 'btn-primary'}
        disabled={!ready || busy}
        onClick={() =>
          publishing ? stop() : start(source ?? { type: 'camera', audio: false })
        }
      >
        {busy ? 'Working…' : publishing ? 'Stop' : '● Go live'}
      </button>

      <span className="flex items-center gap-2 text-xs text-slate-400">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {connection}
      </span>

      {(error ?? initError) && (
        <span className="text-xs text-rose-400">{(error ?? initError)!.message}</span>
      )}
    </div>
  );
}
