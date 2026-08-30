import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PUBLISHER_OPTIONS, usePublisher } from '../hooks/useWebRTC';
import type { PublisherOptions } from '../hooks/useWebRTC';
import type { ConnectionState } from '../types';

interface StreamerProps {
  sessionId: string;
  mirrored: boolean;
  onMirroredChange: (value: boolean) => void;
  onStateChange?: (state: ConnectionState) => void;
  children?: React.ReactNode;
}

const RESOLUTIONS: Array<{ label: string; width: number; height: number }> = [
  { label: '480p', width: 640, height: 480 },
  { label: '540p', width: 960, height: 540 },
  { label: '720p', width: 1280, height: 720 },
];

const FRAME_RATES = [15, 24, 30];

export function Streamer({
  sessionId,
  mirrored,
  onMirroredChange,
  onStateChange,
  children,
}: StreamerProps) {
  const { state, error, stream, start, stop } = usePublisher(sessionId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [options, setOptions] = useState<PublisherOptions>(DEFAULT_PUBLISHER_OPTIONS);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  const live = state === 'connected' || state === 'connecting';

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Source · local camera</span>
        <div className="flex items-center gap-2">
          <span className="chip">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                state === 'connected'
                  ? 'animate-pulse-dot bg-accent'
                  : state === 'error'
                    ? 'bg-rose-500'
                    : live
                      ? 'bg-amber-400'
                      : 'bg-slate-600'
              }`}
            />
            {state}
          </span>
        </div>
      </div>

      <div className="relative aspect-video w-full bg-black">
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
          playsInline
          autoPlay
          // Muted is mandatory: an unmuted local preview creates an audio
          // feedback loop with the microphone being published.
          muted
        />
        {children}
        {!stream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-600">
            <span className="font-mono text-xs uppercase tracking-widest">camera idle</span>
            <span className="text-[11px] text-slate-700">
              press Go live to publish to session “{sessionId}”
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-ink-700 px-4 py-3">
        {live ? (
          <button type="button" className="btn btn-danger" onClick={() => void stop()}>
            ■ Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void start(options)}
            disabled={!sessionId}
          >
            ● Go live
          </button>
        )}

        <select
          className="field"
          disabled={live}
          value={`${options.width}x${options.height}`}
          onChange={(event) => {
            const found = RESOLUTIONS.find(
              (item) => `${item.width}x${item.height}` === event.target.value,
            );
            if (found) {
              setOptions((previous) => ({
                ...previous,
                width: found.width,
                height: found.height,
              }));
            }
          }}
        >
          {RESOLUTIONS.map((item) => (
            <option key={item.label} value={`${item.width}x${item.height}`}>
              {item.label}
            </option>
          ))}
        </select>

        <select
          className="field"
          disabled={live}
          value={options.frameRate}
          onChange={(event) =>
            setOptions((previous) => ({ ...previous, frameRate: Number(event.target.value) }))
          }
        >
          {FRAME_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate} fps
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            className="accent-accent-dim"
            disabled={live}
            checked={options.audio}
            onChange={(event) =>
              setOptions((previous) => ({ ...previous, audio: event.target.checked }))
            }
          />
          microphone
        </label>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            className="accent-accent-dim"
            checked={mirrored}
            onChange={(event) => onMirroredChange(event.target.checked)}
          />
          mirror
        </label>

        {error && (
          <span className="ml-auto max-w-[46ch] truncate font-mono text-[11px] text-rose-400">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
