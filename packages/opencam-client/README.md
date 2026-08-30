# @opencam/client

Realtime **object detection, face recognition, distance estimation, emotion and OCR**
in the browser, from a webcam, a video file, a screen share or an IP camera.

```ts
import { OpenCam } from '@opencam/client';

const cam = new OpenCam({ url: 'http://localhost:8081', sessionId: 'cam-01' });
await cam.init();
await cam.start({ type: 'camera' });

cam.get('objects');   // [{ label: 'laptop', conf: 0.87, box: [x,y,w,h], distance_m: 0.9 }, ...]
cam.get('people');    // [{ id: 3, name: 'Ali Jaafar', distance_m: 0.72, emotion: {...} }]
cam.get('distance');  // 0.72   <- metres to the nearest person
cam.get('text');      // ['HELLO', 'WORLD']
```

The heavy lifting happens in the OpenCam backend container. This package is the
client: it negotiates WebRTC, keeps a live snapshot of the newest inference
pass, and hands you typed accessors over it.

---

## Contents

- [Install](#install)
- [The three-step lifecycle](#the-three-step-lifecycle)
- [Sources](#sources) — camera, screen, file, `<video>`, MediaStream, URL, RTSP/IP camera
- [`get()` — reading results](#get--reading-results)
- [`getVideo()` — raw vs annotated](#getvideo--raw-vs-annotated)
- [Overlays](#overlays)
- [Events](#events)
- [React](#react)
- [Distance: how it works and how to calibrate](#distance-how-it-works-and-how-to-calibrate)
- [Face recognition](#face-recognition)
- [Multiple sessions](#multiple-sessions)
- [API reference](#api-reference)
- [Deployment notes](#deployment-notes)
- [Troubleshooting](#troubleshooting)

---

## Install

The package is not on a public registry. Build it from this repo — in a
container, like everything else here:

```bash
docker compose run --rm sdk bun install
docker compose run --rm sdk bun run build
docker compose run --rm sdk bun pm pack
```

That produces `opencam-client-1.0.0.tgz`. Install it into your app:

```bash
bun add /path/to/opencam-client-1.0.0.tgz
```

Or, if your app lives in the same monorepo, point at the folder directly:

```json
{ "dependencies": { "@opencam/client": "file:../opencam/packages/opencam-client" } }
```

**You also need the backend running.** From the repo root:

```bash
docker compose up -d
```

`react` is an optional peer dependency — only `@opencam/client/react` needs it.

---

## The three-step lifecycle

```ts
const cam = new OpenCam(config);   // 1. construct  - no I/O, safe anywhere
await cam.init();                  // 2. init       - read capabilities, open metadata socket
await cam.start(source);           // 3. start      - acquire media and publish
```

These are separate on purpose:

- **`init()` without `start()`** is a read-only dashboard. It joins a session
  someone *else* is publishing and receives their detections. Nothing is
  captured locally and no permission is requested.
- **`start()` must run inside a user gesture** (a click) when the source is the
  camera or the screen. Browsers refuse `getUserMedia` otherwise, and folding it
  into the constructor would make that impossible to arrange.

```ts
const cam = new OpenCam({ url: 'http://localhost:8081', sessionId: 'cam-01' });

await cam.init();
document.querySelector('#go-live')!.addEventListener('click', async () => {
  await cam.start({ type: 'camera' });
});
```

Shortcut when you already have a gesture:

```ts
import { createOpenCam } from '@opencam/client';
const cam = await createOpenCam({ url: 'http://localhost:8081', sessionId: 'cam-01' });
```

### Config

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | page origin | Backend origin, e.g. `http://localhost:8081`. The default is right when a proxy fronts `/api` and `/ws`. |
| `sessionId` | `'default'` | Stream identity. Two clients with the same id share one stream. |
| `iceServers` | Google STUN | Add TURN for cross-network use. |
| `autoConnect` | `true` | Open the metadata socket during `init()`. |
| `reconnect` | `true` | Reconnect the socket on drop, with exponential backoff. |
| `debug` | `false` | Console diagnostics. |

### Teardown

```ts
await cam.stop();      // stop publishing; metadata socket stays open
await cam.destroy();   // stop everything, close the socket, drop listeners
```

Always `destroy()` on unmount. A live `RTCPeerConnection` keeps the camera LED
on and holds `/dev/video0`, which blocks every other app on Linux.

---

## Sources

`start()` takes any of these. The pipeline downstream is identical no matter
which you pick — same detections, same events, same `get()`.

### Webcam

```ts
await cam.start({ type: 'camera' });

await cam.start({
  type: 'camera',
  width: 1280, height: 720, fps: 30,
  audio: true,
  facingMode: 'user',            // 'environment' for a phone's rear camera
  deviceId: '<from enumerateDevices()>',
});
```

Full control when you need it — `constraints` replaces everything above:

```ts
await cam.start({
  type: 'camera',
  constraints: { video: { width: { exact: 1920 } }, audio: false },
});
```

### Screen / window / tab

```ts
await cam.start({ type: 'screen', audio: false });
```

### A local video file

```ts
const file = (document.querySelector('#picker') as HTMLInputElement).files![0];
await cam.start({ type: 'file', file, loop: true });
```

### A `<video>` element you already have

```ts
await cam.start({ type: 'element', element: document.querySelector('video')! });
```

### A `MediaStream` you already own

```ts
await cam.start({ type: 'stream', stream: myStream });
```

### A URL — the two modes

```ts
// Browser mode: played in a hidden <video>, published from the client.
await cam.start({ type: 'url', url: 'https://example.com/clip.mp4' });

// Server mode: the backend opens it with ffmpeg. The browser never sees it.
await cam.start({ type: 'url', url: 'rtsp://user:pass@192.168.1.50:554/stream1' });
```

Mode is chosen automatically — `rtsp://` and `rtmp://` go server-side, because
no browser can play them; everything else defaults to browser-side. Override
with `mode: 'server' | 'browser'`.

### The server's own camera

```ts
await cam.start({ type: 'url', url: 'device:///dev/video0', mode: 'server' });
```

`device://` opens a local capture device with ffmpeg's v4l2 demuxer. The scheme
is stripped before ffmpeg sees it (v4l2 wants a bare path); keeping a scheme in
the public form is what lets the backend reject schemeless input and not become
a blind file/SSRF primitive. The container needs the device passed in:

```yaml
backend:
  devices: ["/dev/video0:/dev/video0"]
  group_add: ["video"]   # without this the non-root user gets EACCES -> HTTP 409
```

**Prefer server mode for IP cameras.** The credentials in the URL never reach
the client, there is no CORS to satisfy, and the browser is not decoding a
stream it will only re-encode. The trade-off is that there is no local copy of
the video, so `getVideo()` has to fetch it back from the server (see below).

```ts
await cam.start({
  type: 'url',
  mode: 'server',
  url: 'rtsp://192.168.1.50:554/stream1',
  rtspTransport: 'tcp',   // default; UDP loses packets behind NAT
  audio: false,
  format: 'mjpeg',        // force an ffmpeg demuxer if probing guesses wrong
});
```

The backend restricts which URL schemes it will open — see
`INGEST_ALLOWED_SCHEMES`. Narrow it in production: an unrestricted server-side
fetcher is an SSRF primitive.

---

## `get()` — reading results

One method, typed per key. It always returns immediately from the most recent
frame; it never waits. Before the first frame you get empty arrays and `null`s,
never `undefined`.

```ts
cam.get('objects');   // DetectedObject[]
cam.get('faces');     // DetectedFace[]
cam.get('people');    // Person[]   - nearest first, stable ids
cam.get('distance');  // number | null  - metres to the nearest person
cam.get('emotion');   // Emotion | null - the nearest person's emotion
cam.get('names');     // string[]  - recognised identities on camera now
cam.get('text');      // string[]  - OCR results as plain strings
cam.get('texts');     // DetectedText[] - with geometry and confidence
cam.get('audio');     // number 0..1 - microphone level
cam.get('stats');     // PipelineStats | null
cam.get('frame');     // { w, h } | null - source dimensions
cam.get('count');     // { objects, people, faces, texts }
cam.get('raw');       // the whole Snapshot
```

### Shapes

```ts
// get('objects')
{ label: 'laptop', class_id: 63, conf: 0.87,
  box: [412, 208, 190, 130],          // [x, y, w, h] in source-frame pixels
  distance_m: 0.9, distance_method: 'class_prior' }

// get('people')
{ id: 3, age_s: 12.4,
  box: [180, 60, 300, 420],            // body box if known, else face box
  body_box: [180, 60, 300, 420], face_box: [250, 90, 120, 140],
  name: 'Ali Jaafar', similarity: 0.61,
  emotion: { label: 'Happy', conf: 0.93, derived: false, scores: {...} },
  distance_m: 0.72, distance_method: 'ipd',
  confidence: 0.91, has_face: true }

// get('texts')
{ text: 'HELLO', conf: 0.91, box: [40, 300, 120, 34], quad: [[40,300],[160,300],[160,334],[40,334]] }
```

**Every box is `[x, y, width, height]` in source-frame pixels**, origin
top-left, matching `get('frame')`. Inference runs on a downscaled copy, but the
backend maps coordinates back before sending, so you only ever deal with one
coordinate system.

### Query helpers

```ts
cam.has('person');              // boolean
cam.find('cell phone');         // DetectedObject[], strongest first
cam.nearest();                  // Person | null
cam.person(3);                  // Person | null, by tracking id
cam.isPresent('Ali Jaafar');    // boolean
```

### Polling vs events

`get()` is a plain read of cached state — polling it in a `requestAnimationFrame`
loop costs nothing and never blocks:

```ts
function loop() {
  const d = cam.get('distance');
  if (d !== null && d < 0.4) console.log('too close to the screen');
  requestAnimationFrame(loop);
}
loop();
```

If you would rather be pushed than pull, use [events](#events).

---

## `getVideo()` — raw vs annotated

```ts
const clean     = await cam.getVideo();                     // no annotations
const annotated = await cam.getVideo({ annotated: true });  // boxes burned in

document.querySelector('video')!.srcObject = annotated;
```

|  | `annotated: false` (default) | `annotated: true` |
| --- | --- | --- |
| Where it comes from | your local stream (or a clean server track) | the server, re-encoded |
| Added video latency | **zero** for browser sources | one decode → draw → encode → decode cycle |
| Annotations | none — add an [overlay](#overlays) | drawn into the pixels |
| Survives recording | no | yes |
| Cost per extra viewer | none | none (one render feeds all viewers) |

**Use `annotated: false` + an overlay** for a live UI. The picture never leaves
the browser, so the video stays instant and only the JSON round-trips. You also
get to toggle layers client-side with no renegotiation.

**Use `annotated: true`** when the boxes must be *in* the video — recording,
a dumb display client, or verifying exactly what the backend saw.

For a server-ingested source (RTSP), there is no local stream, so
`annotated: false` transparently fetches the clean feed from the server instead.

> **Note on ICE.** If the annotated stream negotiates but no video arrives, the
> cause is almost always ICE candidate selection, not compositing. Hosts with
> many virtual interfaces (docker bridges, VPNs) produce unusable candidate
> pairs; this affects the clean feed identically. Add a TURN server, or test on
> a network where each peer has one obvious address.

---

## Overlays

The zero-latency annotation path: a canvas painted over the untouched video.

```ts
const video  = document.querySelector('video')!;
const canvas = document.querySelector('canvas')!;
video.srcObject = await cam.getVideo();

const detach = cam.attachOverlay(canvas, {
  objects: true, faces: true, texts: true,
  people: false,          // usually redundant with faces + objects
  distance: true,
  labels: true,
  mirrored: false,
  colors: { object: '#38bdf8', face: '#4ade80' },
});

// later
detach();
```

The canvas must sit exactly over the video, and **the video must use
`object-fit: contain`**:

```css
.wrap  { position: relative; }
.wrap video  { width: 100%; height: 100%; object-fit: contain; display: block; }
.wrap canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
```

That is not a style preference. The overlay reproduces the exact letterbox
transform `object-fit: contain` applies, which is what keeps boxes glued to
their subjects at any element size. Switch the video to `cover` and the boxes
will drift.

Mirroring a selfie view? Set `mirrored: true` on the overlay **and**
`transform: scaleX(-1)` on the video. The overlay flips the geometry but keeps
label text readable.

---

## Events

```ts
const off = cam.on('update', (snapshot) => { /* every inference pass */ });
off();  // unsubscribe
```

| Event | Payload | Fires |
| --- | --- | --- |
| `update` | `Snapshot` | Once per inference pass (up to ~25/s). |
| `objects` | `DetectedObject[]` | Every pass. |
| `faces` | `DetectedFace[]` | Every pass. |
| `people` | `Person[]` | Every pass. |
| `text` | `string[]` | When OCR produced anything. |
| `person:enter` | `Person` | A new tracking id appeared. |
| `person:leave` | `Person` | A tracking id disappeared for good. |
| `face:known` | `Person` | A gallery identity became visible. |
| `status` | `StatusMessage` | Publisher/session state changed. |
| `connection` | `ConnectionState` | Socket state changed. |
| `error` | `Error` | Anything went wrong. |

`cam.once(event, fn)` unsubscribes itself after the first call.

```ts
cam.on('person:enter', (p) => console.log(`person ${p.id} at ${p.distance_m}m`));
cam.on('face:known',   (p) => console.log(`hello ${p.name}`));
cam.on('person:leave', (p) => console.log(`person ${p.id} left`));
```

Enter/leave are edges derived from the backend's tracker, which already absorbs
the short gaps caused by dropped frames — so `person:leave` means the person is
actually gone, not that one frame missed them.

A listener that throws is caught and logged; it cannot break the socket loop or
starve the other listeners.

---

## React

```bash
bun add react
```

### Provider

```tsx
import { OpenCamProvider } from '@opencam/client/react';

export default function App() {
  return (
    <OpenCamProvider url="http://localhost:8081" sessionId="cam-01">
      <Dashboard />
    </OpenCamProvider>
  );
}
```

To change `url` or `sessionId` at runtime, remount the provider with a `key` —
mutating a live connection underneath the children is not supported:

```tsx
<OpenCamProvider key={sessionId} sessionId={sessionId} url={url}>
```

### Reading values

```tsx
import { useOpenCamValue } from '@opencam/client/react';

function Readouts() {
  const objects  = useOpenCamValue('objects');
  const distance = useOpenCamValue('distance');
  const people   = useOpenCamValue('people');
  const text     = useOpenCamValue('text');

  return (
    <>
      <p>{distance !== null ? `${distance.toFixed(2)} m away` : 'nobody here'}</p>
      <ul>{objects.map((o, i) => <li key={i}>{o.label} {Math.round(o.conf * 100)}%</li>)}</ul>
      <ul>{people.map((p) => <li key={p.id}>{p.name ?? `#${p.id}`} — {p.emotion?.label}</li>)}</ul>
      <p>{text.join(' · ')}</p>
    </>
  );
}
```

Each hook subscribes to exactly one field. A component reading `distance` does
**not** re-render when only OCR text changed.

### Video

```tsx
import { OpenCamVideo } from '@opencam/client/react';

<OpenCamVideo overlay mirrored style={{ width: 640, height: 480 }} />
<OpenCamVideo annotated />
<OpenCamVideo overlay={{ objects: true, faces: true, texts: false, distance: true }} />
```

### Publishing

```tsx
import { useOpenCamSource } from '@opencam/client/react';

function GoLive() {
  const { start, stop, publishing, busy, error } = useOpenCamSource();
  return (
    <>
      <button disabled={busy} onClick={() => (publishing ? stop() : start({ type: 'camera' }))}>
        {publishing ? 'Stop' : 'Go live'}
      </button>
      {error && <p role="alert">{error.message}</p>}
    </>
  );
}
```

Or publish automatically (no gesture needed for non-camera sources):

```tsx
<OpenCamProvider url="..." autoStart={{ type: 'url', url: 'rtsp://192.168.1.50/stream1' }}>
```

### Other hooks

```tsx
const { cam, ready, error, capabilities, identities } = useOpenCam();
const snapshot   = useOpenCamSnapshot();     // whole snapshot; re-renders every frame
const connection = useOpenCamConnection();   // 'connected' | 'reconnecting' | ...

useOpenCamEvent('person:enter', (p) => toast(`Person ${p.id} arrived`));
```

`useOpenCamEvent` never re-renders — use it for side effects.

### Complete example

```tsx
import {
  OpenCamProvider, OpenCamVideo, useOpenCamValue, useOpenCamSource, useOpenCamEvent,
} from '@opencam/client/react';

function Panel() {
  const { start, stop, publishing } = useOpenCamSource();
  const distance = useOpenCamValue('distance');
  const people   = useOpenCamValue('people');
  const objects  = useOpenCamValue('objects');

  useOpenCamEvent('face:known', (p) => console.log('recognised', p.name));

  return (
    <div>
      <OpenCamVideo overlay mirrored style={{ width: 640, height: 480, background: '#000' }} />
      <button onClick={() => (publishing ? stop() : start({ type: 'camera' }))}>
        {publishing ? 'Stop' : 'Go live'}
      </button>
      <p>Distance: {distance ?? '—'} m · People: {people.length} · Objects: {objects.length}</p>
    </div>
  );
}

export default function App() {
  return (
    <OpenCamProvider url="http://localhost:8081" sessionId="cam-01">
      <Panel />
    </OpenCamProvider>
  );
}
```

---

## Distance: how it works and how to calibrate

A single camera has **no inherent sense of scale** — a small object nearby and a
large one far away project identically. Distance here comes from a *metric
prior* plugged into the pinhole model:

```
distance = (real_size_in_metres × focal_length_in_pixels) / apparent_size_in_pixels
focal_length_in_pixels = (frame_width / 2) / tan(hfov / 2)
```

Two priors are used, with very different quality:

| `distance_method` | Prior | Applies to | Accuracy |
| --- | --- | --- | --- |
| `ipd` | Interpupillary distance, 63 mm | faces with landmarks | **±10%** once calibrated |
| `face_width` | Face width, 150 mm | faces without landmarks | ±20% |
| `class_prior` | Per-class height table | objects | order-of-magnitude only |

`get('distance')` and `Person.distance_m` prefer the face-derived value, because
it is by far the most trustworthy. Interpupillary distance varies little between
adults (SD ≈ 3.5 mm) and is measured between two landmarks the detector already
produces.

**Object distances are hints, not measurements.** A "chair" is anywhere from
0.4 m to 1.2 m tall. Check `distance_method === 'class_prior'` and treat
accordingly, or ignore object distance entirely.

### Calibrate once — this is the difference between a number and a guess

Every estimate scales linearly with `CAMERA_HFOV_DEG`, which defaults to 60°.
If your lens is actually 78°, every distance is out by 30%.

1. Sit at a **measured** 1.00 m from the lens.
2. Read `cam.get('distance')` — say it reports `1.30`.
3. New value: `atan( tan(30°) × 1.30 / 1.00 ) × 2 = 74°`.
4. Put `CAMERA_HFOV_DEG=74` in the repo's `.env` and `docker compose up -d`.

Or, shortcut for a small correction: multiply `tan(hfov/2)` by
`reported / actual`.

Other backend dials: `FACE_IPD_M` (lower it for a child-facing deployment),
`DISTANCE_ENABLED=0` to switch the whole stage off.

---

## Face recognition

Drop photos into the repo's `faces/` directory; the filename becomes the label.

```
faces/Ali_Jaafar.png       -> "Ali Jaafar"
faces/Ali_Jaafar_2.png     -> "Ali Jaafar"   (extra reference for the same person)
faces/Sara_Kassem/1.jpg    -> "Sara Kassem"  (subdirectories work too)
```

They are hot-reloaded on a timer. To force a rescan immediately:

```ts
const identities = await cam.reloadFaces();
```

Recognised names show up in `get('names')`, on `Person.name`, and on
`DetectedFace.name`. Unmatched faces are `"Unknown"` — still detected, still
tracked, still given a distance and an emotion.

Matching uses SFace cosine similarity against a threshold of `0.363`. Raise
`FACE_MATCH_THRESHOLD` toward `0.45` for fewer false identities; lower it toward
`0.30` if a known person keeps reading as Unknown. More reference photos per
person, at different angles and lighting, help more than moving the threshold.

### A note on the `Thinking` emotion

The emotion model has seven classes: angry, disgust, fear, happy, neutral, sad,
surprised. **Thinking is not one of them.** A weakly-confident `neutral` with a
pensive runner-up is relabelled `Thinking` and marked `derived: true`. The full
model distribution is in `emotion.scores` regardless, so you can ignore the
heuristic entirely — or disable it with `EMOTION_THINKING_HEURISTIC=0`.

---

## Multiple sessions

`sessionId` is the stream identity. Independent sessions have their own peer
connections, their own tracking ids, and their own telemetry.

```ts
const lobby   = new OpenCam({ url, sessionId: 'lobby' });
const parking = new OpenCam({ url, sessionId: 'parking' });

await Promise.all([lobby.init(), parking.init()]);
await lobby.start({ type: 'url', url: 'rtsp://192.168.1.50/stream1' });
await parking.start({ type: 'url', url: 'rtsp://192.168.1.51/stream1' });

lobby.get('people');    // only the lobby
parking.get('people');  // only the parking lot
```

Sharing an id is how you build a viewer: one client publishes, any number
`init()` without `start()` and receive the same detections.

What sessions **share** is the backend's compute budget — one thread pool of
`MAX_WORKERS`. Idle sessions cost nothing; busy ones degrade by dropping more
frames rather than thrashing the CPU. Sessions with no publisher, viewer or
socket are reaped after `SESSION_IDLE_TIMEOUT_S`.

---

## API reference

### `new OpenCam(config?)`

| Member | Type | Notes |
| --- | --- | --- |
| `init()` | `Promise<ServerConfig>` | Read capabilities; open the socket. Idempotent. |
| `connect()` | `void` | Open the metadata socket only. |
| `start(source?)` | `Promise<MediaStream \| null>` | Publish. `null` for server ingest. Defaults to `{type:'camera'}`. |
| `stop()` | `Promise<void>` | Stop publishing; keep the socket. |
| `destroy()` | `Promise<void>` | Stop everything; drop listeners. |
| `get(key)` | typed per key | Read the latest snapshot. |
| `getSnapshot()` | `Snapshot` | The whole thing; reference-stable per frame. |
| `has(label)` | `boolean` | Any object with this label visible. |
| `find(label)` | `DetectedObject[]` | Matching detections, strongest first. |
| `nearest()` | `Person \| null` | Closest tracked person. |
| `person(id)` | `Person \| null` | Look up by tracking id. |
| `isPresent(name)` | `boolean` | Is this gallery identity on camera. |
| `getVideo(opts?)` | `Promise<MediaStream>` | Raw or annotated stream. |
| `attachOverlay(canvas, opts?)` | `() => void` | Paint detections; returns detach. |
| `on(event, fn)` | `() => void` | Subscribe; returns unsubscribe. |
| `once(event, fn)` | `() => void` | Auto-unsubscribing subscribe. |
| `reloadFaces()` | `Promise<string[]>` | Rescan `/faces`; returns identities. |
| `sessionId` | `string` | readonly |
| `baseUrl` | `string` | readonly |
| `capabilities` | `Capabilities \| null` | Which stages loaded. |
| `identities` | `string[]` | Known gallery names. |
| `connectionState` | `ConnectionState` | Socket state. |
| `isPublishing` | `boolean` | |

### `get()` keys

| Key | Returns |
| --- | --- |
| `objects` | `DetectedObject[]` |
| `faces` | `DetectedFace[]` |
| `people` / `persons` | `Person[]` (nearest first) |
| `distance` | `number \| null` (metres) |
| `emotion` | `Emotion \| null` |
| `names` | `string[]` |
| `text` | `string[]` |
| `texts` | `DetectedText[]` |
| `audio` | `number` (0..1) |
| `stats` | `PipelineStats \| null` |
| `frame` | `{ w, h } \| null` |
| `count` | `{ objects, people, faces, texts }` |
| `raw` | `Snapshot` |

### React exports

`OpenCamProvider`, `OpenCamVideo`, `useOpenCam`, `useOpenCamValue`,
`useOpenCamSnapshot`, `useOpenCamConnection`, `useOpenCamEvent`,
`useOpenCamSource`.

### Capability detection

Not every stage is guaranteed to be loaded — a missing model file disables its
stage rather than crashing the backend.

```ts
const { capabilities } = await cam.init();
// { objects: true, faces: true, face_recognition: true, emotion: true, ocr: false }

if (!capabilities.ocr) hideTextPanel();
```

---

## Deployment notes

### Secure context

`getUserMedia` requires HTTPS. `http://localhost` counts as secure; a bare LAN
IP like `http://192.168.1.20:5173` does **not** — the camera source will fail
there. Serve your app over TLS, or use Chrome's
`unsafely-treat-insecure-origin-as-secure` flag for local testing.

Server-ingest sources have no such constraint: nothing is captured in the browser.

### CORS

The backend sends `Access-Control-Allow-Origin: *` and exposes the `Location`
header (which the WHIP flow needs), so an app on `http://localhost:3000` can
talk to a backend on `http://localhost:8081` out of the box. Lock that down
before exposing it publicly.

### NAT and TURN

The default STUN server covers same-machine and same-LAN use. Across networks
you need TURN:

```ts
new OpenCam({
  url: 'https://cam.example.com',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
  ],
});
```

The repo's `docker-compose.yml` documents a bridge + coturn configuration at the
bottom of the file.

### Performance

The backend drops frames deliberately — `stats.frames_dropped` climbing is the
design working, not a fault. It runs a latest-frame-wins register rather than a
queue, so lag is bounded at one inference pass no matter how far behind it gets.

`stats.end_to_end_ms` is the number to watch; the target is under 150 ms. If it
is high while `frames_dropped` is near zero, a single inference pass is slow —
lower `INFERENCE_MAX_SIDE` to `480`. If CPU is pegged, raise `OCR_EVERY_N` or
set `OCR_ENABLED=0`.

---

## Troubleshooting

**No permission prompt appears.** It fires on `start()`, never on page load, and
only inside a user gesture. If `start()` runs on a click and there is still no
prompt, the browser has a stored decision for the origin — reset it via the icon
left of the address bar.

**`NotReadableError` / camera busy.** Another app or browser profile holds the
device. On Linux a webcam generally cannot be shared between processes.

**Video connects then dies.** Almost always ICE. Confirm the backend can offer
candidates the browser can reach; across networks, add TURN.

**`"session has no active publisher"`** from `getVideo({annotated:true})`. The
annotated track only exists while something is publishing. Call `start()` first,
or wait for `status`.

**Detections are empty but video works.** Check `cam.capabilities` — a `false`
means that model failed to load. `docker compose logs backend` names the file.

**Boxes are offset from the subjects.** The video is not `object-fit: contain`,
or the canvas is not exactly on top of it. Both are required.

**Nobody is ever recognised.** Confirm `capabilities.face_recognition`, then
check the backend log: reference photos with no detectable face are skipped with
a warning.

**Distances are consistently wrong by the same ratio.** `CAMERA_HFOV_DEG` does
not match your lens. See [calibration](#distance-how-it-works-and-how-to-calibrate).
