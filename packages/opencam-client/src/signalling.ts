/**
 * WHIP-style single-shot SDP exchange.
 *
 * There is no signalling socket and no trickle ICE. The browser gathers every
 * candidate first, POSTs one complete offer, and gets one complete answer back.
 * aiortc finishes gathering inside `setLocalDescription`, so its answer is
 * complete too. One round trip, no state machine.
 *
 * The 3-second gathering cap matters: a browser behind a firewall that cannot
 * reach STUN would otherwise sit in `gathering` until its own much longer
 * internal timeout. Publishing with host candidates alone works fine on a LAN.
 */

const ICE_GATHER_TIMEOUT_MS = 3000;

export async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = window.setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export interface SdpResult {
  answer: string;
  /** Absolute URL of the created resource, for the matching DELETE. */
  resource: string | null;
}

export async function exchangeSdp(
  pc: RTCPeerConnection,
  endpoint: string,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<SdpResult> {
  await waitForIceGathering(pc);

  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error('local description is missing after ICE gathering');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp', ...headers },
    body: sdp,
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `signalling failed: ${response.status} ${response.statusText}${
        detail ? ` - ${detail.slice(0, 300)}` : ''
      }`,
    );
  }

  const answer = await response.text();
  const location = response.headers.get('Location');
  // `Location` comes back relative; resolve it against the endpoint we called
  // so the caller can DELETE it without reconstructing the base URL.
  const resource = location ? new URL(location, endpoint).toString() : null;
  return { answer, resource };
}
