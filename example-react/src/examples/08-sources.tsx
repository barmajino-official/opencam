import { useState } from 'react';
import { useOpenCamSource, useOpenCamValue } from '@opencam/client/react';
import type { Source } from '@opencam/client';
import { Stat } from '../components/ui';

export const meta = {
  title: 'Sources',
  blurb: 'Camera, screen, file, URL, RTSP, or the server’s own device.',
};

/**
 * Every source ends up in the same pipeline, so detections, events and get()
 * behave identically no matter where the pixels came from.
 *
 * The split that matters: browser-side sources are captured here and published
 * over WebRTC; `rtsp://`, `rtmp://` and `device://` are opened by the BACKEND
 * with ffmpeg. No browser can play those, and server-side keeps credentials out
 * of the client. The SDK routes them automatically.
 */
export default function Sources() {
  const { start, stop, publishing, busy, error } = useOpenCamSource();
  const counts = useOpenCamValue('count');
  const [url, setUrl] = useState('rtsp://user:pass@192.168.1.50:554/stream1');

  const options: { label: string; hint: string; source: Source }[] = [
    { label: 'Webcam', hint: 'getUserMedia', source: { type: 'camera' } },
    { label: 'Webcam 720p', hint: 'with constraints', source: { type: 'camera', width: 1280, height: 720, fps: 30 } },
    { label: 'Screen', hint: 'getDisplayMedia', source: { type: 'screen' } },
  ];

  return (
    <div className="space-y-6">
      <div className="card space-y-3">
        <div className="label">Browser sources</div>
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <button
              key={option.label}
              disabled={busy}
              className="btn-ghost"
              onClick={() => start(option.source)}
            >
              {option.label}
              <span className="ml-2 text-[11px] text-slate-500">{option.hint}</span>
            </button>
          ))}

          {/* A local file is played in a hidden <video> and captured from it. */}
          <label className="btn-ghost cursor-pointer">
            Video file…
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void start({ type: 'file', file, loop: true });
              }}
            />
          </label>
        </div>
      </div>

      <div className="card space-y-3">
        <div className="label">Server-pulled source</div>
        <p className="text-sm text-slate-400">
          The backend opens this with ffmpeg; the browser never sees it. Only public hosts are
          allowed by default — loopback, private and link-local addresses are refused to stop the
          endpoint being used to probe your network.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="min-w-[22rem] flex-1 rounded-lg border border-edge bg-ink px-3 py-2 font-mono text-xs text-slate-300"
          />
          <button className="btn-ghost" disabled={busy} onClick={() => start({ type: 'url', url })}>
            Ingest
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Also valid: <code>device:///dev/video0</code> (the server’s own camera — needs
          <code> INGEST_ALLOWED_SCHEMES</code> to include <code>device</code> and the device passed
          into the container).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-ghost" disabled={!publishing} onClick={() => stop()}>
          Stop
        </button>
        <span className="text-xs text-slate-400">{publishing ? 'publishing' : 'idle'}</span>
        {error && <span className="text-xs text-rose-400">{error.message}</span>}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Objects" value={counts.objects} />
        <Stat label="People" value={counts.people} />
        <Stat label="Text" value={counts.texts} />
      </div>
    </div>
  );
}
