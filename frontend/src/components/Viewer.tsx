import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../hooks/useWebRTC';

interface ViewerProps {
  sessionId: string;
  enabled: boolean;
}

/**
 * Server-rendered feed: annotations are baked into the video by OpenCV on the
 * backend, and the publisher's audio is relayed alongside it. Costs one extra
 * encode/decode round trip versus the raw + SVG overlay mode, which is exactly
 * the trade-off the mode toggle exists to expose.
 */
export function Viewer({ sessionId, enabled }: ViewerProps) {
  const { state, error, stream } = useViewer(sessionId, enabled);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Server-rendered · annotated re-broadcast</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn px-2 py-1"
            onClick={() => setMuted((value) => !value)}
            disabled={!stream}
          >
            {muted ? '🔇 unmute' : '🔊 audio on'}
          </button>
          <span className="chip">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                state === 'connected'
                  ? 'animate-pulse-dot bg-accent'
                  : state === 'error'
                    ? 'bg-rose-500'
                    : 'bg-amber-400'
              }`}
            />
            {state}
          </span>
        </div>
      </div>

      <div className="relative aspect-video w-full bg-black">
        <video ref={videoRef} className="h-full w-full object-contain" playsInline autoPlay muted />
        {!stream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-slate-600">
            <span className="font-mono text-xs uppercase tracking-widest">
              {state === 'error' ? 'unavailable' : 'negotiating…'}
            </span>
            {error && <span className="text-[11px] text-rose-400/80">{error}</span>}
            {!error && (
              <span className="text-[11px] text-slate-700">
                a publisher must be live on “{sessionId}” before the annotated feed exists
              </span>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-ink-700 px-4 py-2.5 text-[11px] text-slate-500">
        Boxes, identities, emotions and OCR are drawn server-side with OpenCV, then re-encoded.
        Audio is relayed untouched and stays in sync via copied frame timestamps.
      </div>
    </div>
  );
}
