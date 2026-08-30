/**
 * Turning a {@link Source} into a publishable `MediaStream`.
 *
 * Everything except `{type:'url', mode:'server'}` resolves to a browser-side
 * stream that gets published over WebRTC. Server-mode URLs never produce a
 * local stream at all — the backend opens them with ffmpeg — so this module
 * reports that case back rather than inventing one.
 */

import type { Source } from './types.js';

export interface ResolvedSource {
  /** `null` only for server-side ingest, which has no browser-side media. */
  stream: MediaStream | null;
  /** Hidden element to revoke/teardown when the source stops. */
  cleanup?: () => void;
  /** True when the backend must pull this source itself. */
  serverIngest?: { url: string; loop: boolean; rtspTransport: string; audio: boolean; format?: string };
}

/** Schemes no browser can play, so they must be pulled server-side. */
const SERVER_ONLY_SCHEMES = ['rtsp:', 'rtmp:', 'rtsps:', 'rtmps:', 'device:'];

export function isServerOnlyUrl(url: string): boolean {
  try {
    return SERVER_ONLY_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function fromCamera(source: Extract<Source, { type: 'camera' }>): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'getUserMedia is unavailable. It requires a secure context: https, or http on localhost.',
    );
  }

  const constraints: MediaStreamConstraints = source.constraints ?? {
    video: {
      ...(source.deviceId ? { deviceId: { exact: source.deviceId } } : {}),
      ...(source.facingMode ? { facingMode: source.facingMode } : {}),
      width: { ideal: source.width ?? 640 },
      height: { ideal: source.height ?? 480 },
      frameRate: { ideal: source.fps ?? 30 },
    },
    audio: source.audio ?? true,
  };

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    const err = error as DOMException;
    // These three are the ones users actually hit, and the browser's own
    // messages ("Permission denied") do not say which one it was.
    if (err.name === 'NotAllowedError') {
      throw new Error(
        'Camera/microphone permission was denied. Reset it via the icon left of the address bar.',
      );
    }
    if (err.name === 'NotFoundError') {
      throw new Error('No camera or microphone matched the requested constraints.');
    }
    if (err.name === 'NotReadableError') {
      throw new Error(
        'The camera is already in use by another application or browser profile.',
      );
    }
    throw error;
  }
}

/** Plays `src` in a detached <video> and captures it as a stream. */
async function fromMediaElement(
  src: string,
  { loop = false, muted = true, revoke = false }: { loop?: boolean; muted?: boolean; revoke?: boolean },
): Promise<ResolvedSource> {
  const video = document.createElement('video');
  video.src = src;
  video.loop = loop;
  video.muted = muted;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  // Kept out of the layout tree but NOT `display:none`: a hidden element is
  // allowed to stop rendering frames, which starves captureStream().
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;';
  document.body.appendChild(video);

  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () =>
      reject(
        new Error(
          `could not load media from ${src.slice(0, 120)} (unsupported codec, or CORS on the media host)`,
        ),
      );
  });
  await video.play();

  const capture = (video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  });
  const grab = capture.captureStream ?? capture.mozCaptureStream;
  if (!grab) throw new Error('this browser does not support HTMLVideoElement.captureStream()');

  return {
    stream: grab.call(video),
    cleanup: () => {
      video.pause();
      video.remove();
      if (revoke) URL.revokeObjectURL(src);
    },
  };
}

export async function resolveSource(source: Source): Promise<ResolvedSource> {
  switch (source.type) {
    case 'camera':
      return { stream: await fromCamera(source) };

    case 'screen': {
      const media = navigator.mediaDevices as MediaDevices & {
        getDisplayMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
      };
      if (!media.getDisplayMedia) throw new Error('screen capture is unsupported in this browser');
      return { stream: await media.getDisplayMedia({ video: true, audio: source.audio ?? false }) };
    }

    case 'stream':
      return { stream: source.stream };

    case 'element': {
      const el = source.element as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const grab = el.captureStream ?? el.mozCaptureStream;
      if (!grab) throw new Error('this browser does not support HTMLVideoElement.captureStream()');
      return { stream: grab.call(el) };
    }

    case 'file': {
      const objectUrl = URL.createObjectURL(source.file);
      return fromMediaElement(objectUrl, {
        loop: source.loop ?? false,
        muted: source.muted ?? true,
        revoke: true,
      });
    }

    case 'url': {
      const mode = source.mode ?? (isServerOnlyUrl(source.url) ? 'server' : 'browser');
      if (mode === 'server') {
        return {
          stream: null,
          serverIngest: {
            url: source.url,
            loop: source.loop ?? false,
            rtspTransport: source.rtspTransport ?? 'tcp',
            audio: source.audio ?? true,
            ...(source.format ? { format: source.format } : {}),
          },
        };
      }
      return fromMediaElement(source.url, { loop: source.loop ?? false, muted: true });
    }

    default: {
      const exhaustive: never = source;
      throw new Error(`unsupported source: ${JSON.stringify(exhaustive)}`);
    }
  }
}
