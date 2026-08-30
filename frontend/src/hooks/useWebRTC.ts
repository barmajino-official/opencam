import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState } from '../types';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_GATHER_TIMEOUT_MS = 3000;

/**
 * Signalling is non-trickle: we wait for ICE gathering to finish, then POST one
 * complete SDP offer. aiortc gathers fully inside setLocalDescription, so the
 * answer comes back complete too and the exchange is a single round trip.
 *
 * The timeout matters — with a STUN server configured, gathering occasionally
 * never reaches "complete" (a candidate type times out silently). Sending the
 * host candidates we already have is strictly better than hanging forever.
 */
async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;

  await new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      window.clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = window.setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/** Posts the fully-gathered local offer and returns [answerSdp, resourceUrl]. */
async function exchangeSdp(pc: RTCPeerConnection, url: string): Promise<[string, string]> {
  await waitForIceGathering(pc);
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error('local description missing');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: sdp,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      response.status === 409
        ? body.includes('publisher')
          ? 'no active publisher for this session yet'
          : body.slice(0, 160)
        : `signalling failed: ${response.status} ${body.slice(0, 160)}`,
    );
  }

  return [await response.text(), response.headers.get('Location') ?? url];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Publisher — local camera + microphone -> backend (WHIP)
// ---------------------------------------------------------------------------

export interface PublisherOptions {
  width: number;
  height: number;
  frameRate: number;
  audio: boolean;
}

export const DEFAULT_PUBLISHER_OPTIONS: PublisherOptions = {
  width: 640,
  height: 480,
  frameRate: 30,
  audio: true,
};

export function usePublisher(sessionId: string) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const resourceRef = useRef<string | null>(null);

  const stop = useCallback(async () => {
    const pc = pcRef.current;
    const resource = resourceRef.current;
    pcRef.current = null;
    resourceRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);

    pc?.close();
    setState('idle');

    if (resource) {
      // Best-effort teardown; the backend also reaps on connection failure.
      try {
        await fetch(resource, { method: 'DELETE' });
      } catch {
        /* ignore */
      }
    }
  }, []);

  const start = useCallback(
    async (options: PublisherOptions = DEFAULT_PUBLISHER_OPTIONS) => {
      if (pcRef.current) await stop();

      setError(null);
      setState('connecting');

      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: options.width },
            height: { ideal: options.height },
            frameRate: { ideal: options.frameRate },
          },
          audio: options.audio
            ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            : false,
        });

        streamRef.current = media;
        setStream(media);

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        pc.addEventListener('connectionstatechange', () => {
          switch (pc.connectionState) {
            case 'connected':
              setState('connected');
              break;
            case 'connecting':
              setState('connecting');
              break;
            case 'failed':
              setError('peer connection failed');
              setState('error');
              break;
            case 'disconnected':
              setState('reconnecting');
              break;
            case 'closed':
              setState('closed');
              break;
          }
        });

        for (const track of media.getTracks()) {
          pc.addTrack(track, media);
        }

        await pc.setLocalDescription(await pc.createOffer());

        const [answerSdp, resource] = await exchangeSdp(
          pc,
          `/api/whip/${encodeURIComponent(sessionId)}`,
        );
        resourceRef.current = resource;
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      } catch (caught) {
        setError(errorMessage(caught));
        setState('error');
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setStream(null);
        pcRef.current?.close();
        pcRef.current = null;
      }
    },
    [sessionId, stop],
  );

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, []);

  return { state, error, stream, start, stop };
}

// ---------------------------------------------------------------------------
// Viewer — backend annotated track + audio -> local <video>
// ---------------------------------------------------------------------------

export function useViewer(sessionId: string, enabled: boolean) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setState('idle');
      setStream(null);
      return;
    }

    let disposed = false;
    let resource: string | null = null;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    const remote = new MediaStream();

    pc.addEventListener('track', (event) => {
      remote.addTrack(event.track);
      if (!disposed) setStream(remote);
    });

    pc.addEventListener('connectionstatechange', () => {
      if (disposed) return;
      if (pc.connectionState === 'connected') setState('connected');
      else if (pc.connectionState === 'failed') {
        setError('viewer connection failed');
        setState('error');
      } else if (pc.connectionState === 'closed') setState('closed');
    });

    (async () => {
      try {
        setError(null);
        setState('connecting');

        // recvonly transceivers, added in the order the backend attaches tracks.
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        await pc.setLocalDescription(await pc.createOffer());

        const [answerSdp, resourceUrl] = await exchangeSdp(
          pc,
          `/api/watch/${encodeURIComponent(sessionId)}`,
        );
        resource = resourceUrl;
        if (disposed) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      } catch (caught) {
        if (disposed) return;
        setError(errorMessage(caught));
        setState('error');
      }
    })();

    return () => {
      disposed = true;
      pc.close();
      pcRef.current = null;
      setStream(null);
      if (resource) {
        void fetch(resource, { method: 'DELETE' }).catch(() => undefined);
      }
    };
  }, [sessionId, enabled]);

  return { state, error, stream, peerConnection: pcRef };
}
