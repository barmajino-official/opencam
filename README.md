# OpenCam — realtime WebRTC computer-vision pipeline

Browser camera → WebRTC → Python inference engine → live JSON metadata + an
annotated re-broadcast stream. Object detection, face recognition, facial
emotion and scene OCR, all on modest CPU hardware, all inside Docker.

```
┌──────────────┐   WHIP / SDP    ┌───────────────────────────────────┐
│  frontend    │ ──── video ───▶ │  backend (FastAPI + aiortc)       │
│  React + TS  │ ──── audio ───▶ │                                   │
│              │                 │  ┌─ YOLOv8n ────── objects        │
│  ◀── JSON ───┼── WebSocket ────┤  ├─ YuNet + SFace ─ identities    │
│              │                 │  ├─ MobileFaceNet ─ emotions      │
│  ◀── RTP ────┼── annotated ────┤  └─ PPOCR + CRNN ── text          │
└──────────────┘                 └───────────────────────────────────┘
```

---

## Quick start

```bash
cp .env.example .env          # optional — every value has a working default
docker compose up --build     # first build takes ~5-10 min (models are baked in)
```

Open **<http://localhost:5173>**, press **● Go live**, allow camera and
microphone. Boxes, names, emotions and OCR appear immediately; the detection log
on the right narrates what the pipeline sees.

To recognise yourself, drop a photo into `faces/` named after you
(`faces/Ali_Jaafar.png` → “Ali Jaafar”) and press **↻ faces**. See
[`faces/README.md`](faces/README.md) for naming rules and tuning.

> `getUserMedia` requires a secure context. `http://localhost` counts; a bare LAN
> IP does not. To use another machine's browser, put the frontend behind TLS or
> add the origin to Chrome's `unsafely-treat-insecure-origin-as-secure` flag.

---

## What is verified

Measured on a live webcam and a real WebRTC client (aiortc), not asserted:

| Capability | Status | Evidence |
| --- | --- | --- |
| Object detection | ✅ | `person` detected in 25/25 frames, 91% conf |
| Face recognition | ✅ | matched `barmajino` at 0.72 similarity (threshold 0.363) |
| Distance | ✅ | 0.53 m via IPD; falls monotonically as the subject approaches |
| Emotion | ✅ | `Neutral 0.996`, `Happy` on expression change |
| OCR | ✅ | read `opencam` off a synthetic frame |
| People fusion + tracking | ✅ | one record per human, id stable across all frames |
| WHIP publish (WebRTC in) | ✅ | aiortc client published; inference flowed |
| Metadata websocket | ✅ | 8+ inference frames, full payload |
| Raw video egress | ✅ | 5 frames received, 640×480 |
| Server ingest (file / device / RTSP) | ✅ | file + `/dev/video0` ingested; bad URLs rejected 409 |
| SDK build + import | ✅ | strict `tsc` clean, exports resolve, letterbox maths correct |
| Server-rendered (annotated) egress | ✅ | 8 frames received; annotated vs raw pixel diff 4.19 (compositing confirmed) |

Not covered here: publishing from a real browser. The aiortc client speaks the
same WHIP/SDP protocol and succeeds, but no browser automation was available to
click **● Go live** directly.

> **ICE on multi-interface hosts.** These tests are only reliable when each peer
> has one obvious address. On a host with ~20 docker bridges plus a VPN, aiortc
> ↔ aiortc negotiation picks unusable candidate pairs and media silently fails to
> flow — in both directions, for annotated *and* clean feeds. If media stalls
> while signalling succeeds, that is the cause; a browser on the same LAN is not
> affected in the same way. Run container-to-container tests on a dedicated
> docker network.

---

## Nothing runs on the host

Both services are containers, and everything they need is baked into the images
at build time — including all five ONNX models. There is no setup script, no
`pip install`, no model download at first run, and no writable model cache to
warm. The only host-side artifacts are `docker-compose.yml`, `.env` and the
photos you put in `faces/`.

Need a one-off command? Use an ephemeral container:

```bash
# Inspect the baked models
docker run --rm --entrypoint sh opencam-backend:1.0.0 -c 'ls -lh /models'

# Typecheck the frontend without installing a toolchain
docker run --rm --network host -v /etc/resolv.conf:/etc/resolv.conf:ro \
  -v "$PWD/frontend:/app" -w /app oven/bun:1-alpine \
  sh -c 'bun install && bun run typecheck'
```

---

## Use it as a library

Everything the dashboard does is available as an importable package,
[`@opencam/client`](packages/opencam-client/README.md) — TypeScript, React
bindings included.

```ts
import { OpenCam } from '@opencam/client';

const cam = new OpenCam({ url: 'http://localhost:8081', sessionId: 'cam-01' });
await cam.init();
await cam.start({ type: 'camera' });   // or a file, a screen, or an RTSP URL

cam.get('objects');   // [{ label: 'laptop', conf: 0.87, box: [x,y,w,h], distance_m: 0.9 }]
cam.get('people');    // [{ id: 3, name: 'Ali Jaafar', distance_m: 0.72, emotion: {...} }]
cam.get('distance');  // 0.72  <- metres to the nearest person
cam.get('text');      // ['HELLO', 'WORLD']

const stream = await cam.getVideo({ annotated: true });   // boxes burned in
```

React:

```tsx
<OpenCamProvider url="http://localhost:8081" sessionId="cam-01">
  <OpenCamVideo overlay mirrored />
</OpenCamProvider>

const distance = useOpenCamValue('distance');
```

Build it — in a container, like everything else here:

```bash
docker compose run --rm sdk bun install
docker compose run --rm sdk bun run build
docker compose run --rm sdk bun pm pack   # -> opencam-client-1.0.0.tgz
```

Full API reference, source types, calibration guide and troubleshooting:
**[`packages/opencam-client/README.md`](packages/opencam-client/README.md)**.

---

## Runnable examples

`example-react/` is a menu-driven React app covering every part of the SDK. Each
page is one small file and shows **its own source** below the live demo, so the
code you read is the code running.

```bash
docker compose run --rm sdk bun install   # build the SDK (dist/ is not committed)
docker compose run --rm sdk bun run build
docker compose up -d                      # backend
./example-react/run.sh                    # then the examples
```

Open **<http://127.0.0.1:5174>**. It calls the backend cross-origin, so that
origin is in `CORS_ALLOW_ORIGINS` by default, and each browser tab gets its own
`sessionId` — publishing to a session that already has a publisher replaces it,
so a shared id would make two tabs evict each other.

The script is a one-line `docker run --rm` — nothing is installed on the host:

```bash
docker run --rm -it --network host \
  -v /etc/resolv.conf:/etc/resolv.conf:ro \
  -v "$PWD:/repo" -w /repo/example-react \
  oven/bun:1-alpine sh -c 'bun install && bun run dev'
```

| # | Page | Shows |
| --- | --- | --- |
| 01 | Quick start | init → start → `get()`; why the prompt needs a click |
| 02 | Object detection | `get('objects')`, boxes in source-frame pixels |
| 03 | Face recognition | identities, similarity, live `/faces` rescan |
| 04 | Distance | `get('distance')` plus a calibration helper |
| 05 | Emotion | winning label and the full model distribution |
| 06 | Text / OCR | `get('text')` and why it updates more slowly |
| 07 | People tracking | fused body+face records, stable ids, enter/leave |
| 08 | Sources | camera, screen, file, URL, RTSP, `device://` |
| 09 | Video modes | clean vs client overlay vs server-composited |
| 10 | Overlay options | layer toggles, colours, mirroring |
| 11 | Events | push instead of poll, without re-rendering |
| 12 | Telemetry | the latency budget, and why dropped frames are correct |
| 13 | Multi-session | independent sessions sharing one compute budget |
| 14 | Snapshot inspector | every `get()` key, live, with real shapes |

Adding a page is dropping a file into `src/examples/` that exports a component
and a `meta` object — the menu, the route and the source viewer pick it up
automatically. Details in
[`example-react/README.md`](example-react/README.md).

---

## Cookbook — one example of everything

Every snippet below is complete and runnable against `docker compose up`.

### Connect and read results

```ts
import { OpenCam } from '@opencam/client';

const cam = new OpenCam({ url: 'http://localhost:8081', sessionId: 'cam-01' });
await cam.init();                      // capabilities + metadata socket
await cam.start({ type: 'camera' });   // must be inside a click handler

cam.get('objects');   // DetectedObject[]
cam.get('faces');     // DetectedFace[]
cam.get('people');    // Person[] - nearest first, stable ids
cam.get('distance');  // number | null - metres to the nearest person
cam.get('emotion');   // Emotion | null - the nearest person's emotion
cam.get('names');     // string[] - recognised identities on camera now
cam.get('text');      // string[] - OCR as plain strings
cam.get('texts');     // DetectedText[] - with geometry + confidence
cam.get('audio');     // number 0..1 - mic level
cam.get('stats');     // PipelineStats | null
cam.get('frame');     // { w, h } | null
cam.get('count');     // { objects, people, faces, texts }
cam.get('raw');       // the whole Snapshot
```

Real output from the live camera test:

```jsonc
// get('people')[0]
{ "id": 1, "age_s": 4.2,
  "box": [38,56,561,417], "body_box": [38,56,561,417], "face_box": [250,90,120,140],
  "name": "barmajino", "similarity": 0.72,
  "emotion": { "label": "Neutral", "conf": 0.996, "derived": false, "scores": {} },
  "distance_m": 0.53, "distance_method": "ipd",
  "confidence": 0.94, "has_face": true }
```

### Every source type

```ts
await cam.start({ type: 'camera' });                                  // webcam
await cam.start({ type: 'camera', width: 1280, height: 720, fps: 30,
                  facingMode: 'user', audio: true });
await cam.start({ type: 'screen' });                                  // screen share
await cam.start({ type: 'stream', stream: myMediaStream });           // stream you own
await cam.start({ type: 'element', element: videoEl });               // existing <video>
await cam.start({ type: 'file', file: input.files![0], loop: true }); // local file
await cam.start({ type: 'url', url: 'https://cdn/clip.mp4' });        // played in-browser

// Pulled by the backend with ffmpeg - the browser never sees these.
await cam.start({ type: 'url', url: 'rtsp://user:pass@192.168.1.50:554/stream1',
                  rtspTransport: 'tcp', audio: false });
await cam.start({ type: 'url', url: 'device:///dev/video0',           // server's own camera
                  mode: 'server' });
```

`rtsp://`, `rtmp://` and `device://` route server-side automatically — no browser
can play them, and credentials never reach the client.

### Video, with and without annotations

```ts
const clean = await cam.getVideo();                     // no added latency
videoEl.srcObject = clean;

const burned = await cam.getVideo({ annotated: true });   // boxes burned in
```

### Overlay (the recommended way to draw boxes)

```ts
videoEl.srcObject = await cam.getVideo();
const detach = cam.attachOverlay(canvasEl, {
  objects: true, faces: true, texts: true, people: false,
  distance: true, labels: true, mirrored: false,
  colors: { object: '#38bdf8', face: '#4ade80' },
});
// detach();
```

```css
.wrap        { position: relative; }
.wrap video  { width: 100%; height: 100%; object-fit: contain; display: block; }
.wrap canvas { position: absolute; inset: 0; width: 100%; height: 100%;
               pointer-events: none; }
```

`object-fit: contain` is required — the overlay reproduces exactly that
letterbox transform. Use `cover` and the boxes drift off their subjects.

### Events

```ts
cam.on('update',       (snap) => console.log(snap.seq, snap.people.length));
cam.on('objects',      (objs) => {});
cam.on('people',       (ppl)  => {});
cam.on('text',         (lines) => {});
cam.on('person:enter', (p) => console.log(`person ${p.id} at ${p.distance_m}m`));
cam.on('person:leave', (p) => console.log(`person ${p.id} left`));
cam.on('face:known',   (p) => console.log(`hello ${p.name}`));
cam.on('connection',   (state) => {});
cam.on('error',        (err) => console.error(err));

const off = cam.on('update', fn);  off();      // unsubscribe
cam.once('face:known', (p) => greet(p.name));  // fires once
```

### Query helpers

```ts
cam.has('person');            // boolean
cam.find('cell phone');       // DetectedObject[], strongest first
cam.nearest();                // Person | null
cam.person(1);                // Person | null, by tracking id
cam.isPresent('barmajino');   // boolean
await cam.reloadFaces();      // rescan /faces, returns identities
```

### React

```tsx
import {
  OpenCamProvider, OpenCamVideo,
  useOpenCam, useOpenCamValue, useOpenCamSource, useOpenCamEvent,
  useOpenCamConnection, useOpenCamSnapshot,
} from '@opencam/client/react';

function Panel() {
  const { start, stop, publishing, error } = useOpenCamSource();
  const distance = useOpenCamValue('distance');
  const people   = useOpenCamValue('people');
  const objects  = useOpenCamValue('objects');
  const state    = useOpenCamConnection();

  useOpenCamEvent('face:known', (p) => console.log('recognised', p.name));

  return (
    <div>
      <OpenCamVideo overlay mirrored style={{ width: 640, height: 480, background: '#000' }} />
      <button onClick={() => (publishing ? stop() : start({ type: 'camera' }))}>
        {publishing ? 'Stop' : 'Go live'}
      </button>
      <p>{state} · {distance ?? '—'} m · {people.length} people · {objects.length} objects</p>
      {people.map((p) => (
        <div key={p.id}>{p.name ?? `#${p.id}`} — {p.emotion?.label} — {p.distance_m} m</div>
      ))}
      {error && <p role="alert">{error.message}</p>}
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

Each `useOpenCamValue` subscribes to one field, so a component reading
`distance` does not re-render when only OCR text changed.

### Capability detection

```ts
const { capabilities } = await cam.init();
// { objects: true, faces: true, face_recognition: true, emotion: true, ocr: true }
if (!capabilities.ocr) hideTextPanel();
```

### Multiple sessions

```ts
const lobby   = new OpenCam({ url, sessionId: 'lobby' });
const parking = new OpenCam({ url, sessionId: 'parking' });
await Promise.all([lobby.init(), parking.init()]);
await lobby.start({   type: 'url', url: 'rtsp://192.168.1.50/stream1' });
await parking.start({ type: 'url', url: 'rtsp://192.168.1.51/stream1' });
lobby.get('people');    // only the lobby
```

One client publishes; any number call `init()` without `start()` to watch the
same session's detections.

### Straight HTTP, no SDK

```bash
curl -s localhost:8081/api/config                       # capabilities + tuning
curl -s localhost:8081/api/sessions                     # active sessions
curl -s localhost:8081/api/faces                        # known identities
curl -X POST localhost:8081/api/faces/reload            # rescan /faces

curl -X POST localhost:8081/api/ingest/cam-01 \
     -H 'Content-Type: application/json' \
     -d '{"url":"rtsp://192.168.1.50:554/stream1","rtsp_transport":"tcp"}'

curl -X POST localhost:8081/api/ingest/cam-01 \
     -H 'Content-Type: application/json' \
     -d '{"url":"device:///dev/video0","width":640,"height":480,"fps":30}'

curl -X DELETE localhost:8081/api/ingest/cam-01
```

Ingesting the server's own camera needs the device in the container:

```yaml
backend:
  devices: ["/dev/video0:/dev/video0"]
  group_add: ["video"]        # without this the non-root user gets EACCES -> 409
```

### Websocket directly

```js
const ws = new WebSocket('ws://localhost:8081/ws/cam-01');
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type !== 'inference') return;
  console.log(m.seq, m.people, m.objects, m.texts, m.stats.end_to_end_ms);
};
```

### Recognising a person

```bash
cp ~/photos/me.jpg faces/Ali_Jaafar.png    # filename becomes the label
curl -X POST localhost:8081/api/faces/reload
```

`faces/Ali_Jaafar_2.png` adds another reference for the same person;
`faces/Sara_Kassem/1.jpg` works too.

### Calibrating distance

```ts
// 1. sit at a measured 1.00 m
cam.get('distance');   // suppose it reports 1.30
// 2. new FOV = 2 * atan( tan(30deg) * 1.30 / 1.00 ) = 74 degrees
```

```bash
echo "CAMERA_HFOV_DEG=74" >> .env && docker compose up -d
```

Every estimate scales linearly with this value, so it is the difference between
a number and a guess.

---

## The two display modes

The mode toggle exists to make a real architectural trade-off visible, not as a
cosmetic preference.

**Raw feed + overlay** (default) shows the local camera with boxes drawn as an
SVG layer on top. Video never leaves the browser, so this adds **zero** latency
to the picture — only the JSON metadata makes the round trip. Individual layers
(objects / faces / OCR) can be toggled client-side, instantly.

**Server rendered** receives a second WebRTC stream where OpenCV has already
composited the annotations into the pixels, with the publisher's audio relayed
alongside. It costs an extra decode → draw → encode → decode cycle, but the
annotations are burned in — which is what you want for recording, for clients
that cannot run the overlay, or to confirm exactly what the backend saw.

The camera keeps publishing in both modes; switching does not renegotiate the
upstream connection.

---

## How the latency budget is met

The target is <150 ms from capture to metadata. Four decisions do the work:

**1. Latest-frame-wins, never a queue.** A FIFO between capture and inference
guarantees lag that grows without bound the moment inference is slower than the
camera. Each session instead owns a *single-slot register*: a new frame
overwrites whatever is pending. Worst-case lag is one inference pass, forever.
`frames_dropped` in the telemetry bar is the mechanism working, not a fault —
at 30 fps capture and 20 fps inference, a third of frames *should* be skipped.

**2. Independent cadences.** OCR is 5–10× more expensive than everything else,
so it runs on a separate worker at 1/N cadence (`OCR_EVERY_N`) with its result
carried forward under a TTL. A slow text pass can never stall the fast path.

**3. Skip the work before doing the work.** The track consumer asks
`engine.wants_frame()` *before* converting a frame to a NumPy array — a
conversion that costs real milliseconds at 720p. When the engine is busy, the
frame is dropped without ever being decoded to BGR.

**4. One annotation pass, many viewers.** Two `MediaRelay` instances sit in the
media graph: an ingress relay lets inference and annotation pull the same
inbound track without stealing frames from each other, and an egress relay fans
the *already-annotated* track out to every viewer. Ten people watching costs one
annotation pass, not ten.

Measured end-to-end latency is shown live in the telemetry bar and turns amber
above 150 ms, red above 300 ms.

---

## Model choices

Every model is ONNX, CPU-real-time, and small. Four of the five are driven by
wrappers already compiled into the OpenCV wheel, so the container needs no
PyTorch, no dlib and no InsightFace at runtime.

| Stage | Model | Size | Runner |
| ----- | ----- | ---- | ------ |
| Objects | YOLOv8n (80 COCO classes) | ~12 MB | ONNX Runtime |
| Face detection | YuNet | ~350 KB | `cv2.FaceDetectorYN` |
| Face identity | SFace (128-d embeddings) | ~37 MB | `cv2.FaceRecognizerSF` |
| Emotion | MobileFaceNet FER (7 classes) | ~1 MB | `cv2.dnn` |
| Text detection | PP-OCRv3 EN (DB head) | ~2 MB | `cv2.dnn.TextDetectionModel_DB` |
| Text recognition | CRNN EN (36 symbols) | ~9 MB | `cv2.dnn.TextRecognitionModel` |

YOLOv8n is exported from the official `.pt` weights in a throwaway build stage;
CPU-only Torch lives there and never reaches the runtime image. The rest come
from the [OpenCV Zoo](https://github.com/opencv/opencv_zoo).

**If a model cannot be fetched at build time**, its stage starts disabled and
says so in the log — the rest of the pipeline keeps working, and the dashboard
greys out the missing capability rather than failing.

### About the “Thinking” emotion

The FER model was trained on seven classes: angry, disgust, fear, happy,
neutral, sad, surprised. *Thinking is not one of them.* The label is derived: a
weakly-confident neutral prediction with a pensive runner-up is reported as
“Thinking”, marked `derived: true` in the payload, and the full model
distribution ships in every message so you can ignore the heuristic entirely.
Disable it with `EMOTION_THINKING_HEURISTIC=0`.

---

## Multi-session

Every stream is keyed by a `session_id` that appears in the URL hash
(`http://localhost:5173/#/cam-01`), so a dashboard is shareable and reloadable.
Sessions are fully independent: their own peer connections, their own inference
engine instance, their own websocket fan-out, their own telemetry.

What they *share* is the process-wide compute budget — one thread pool of
`MAX_WORKERS` threads and a matching pool of model bundles. This is deliberate:
five idle sessions cost almost nothing, and five busy sessions degrade
gracefully by dropping more frames rather than by thrashing the CPU.

Open a second browser tab on `#/cam-02` to see it. The header lists every active
session with a live publishing indicator. Sessions with no publisher, viewer or
dashboard are reaped after `SESSION_IDLE_TIMEOUT_S`.

---

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/api/whip/{session_id}` | WHIP ingest. Body: raw SDP offer. Returns SDP answer. |
| `DELETE` | `/api/whip/{session_id}` | Stop publishing. |
| `POST` | `/api/watch/{session_id}` | Subscribe to the annotated track. Body: raw SDP offer. Add `?annotated=0` for the clean feed. |
| `DELETE` | `/api/watch/{session_id}/{viewer_id}` | Detach a viewer. |
| `POST` | `/api/ingest/{session_id}` | Server-side pull. Body: `{"url": "rtsp://..."}`. |
| `DELETE` | `/api/ingest/{session_id}` | Stop the server-side source. |
| `WS` | `/ws/{session_id}` | Per-frame inference JSON. |
| `GET` | `/api/sessions` | All active sessions + telemetry. |
| `GET` | `/api/config` | Which stages actually loaded, and the tuning in effect. |
| `GET` | `/api/faces` · `POST /api/faces/reload` | Known identities; force a rescan. |
| `GET` | `/api/health` | Liveness. |

Signalling is single-shot SDP, no trickle ICE: aiortc completes gathering inside
`setLocalDescription`, and the browser waits for `iceGatheringState === 'complete'`
(with a 3 s fallback) before posting. One round trip, no signalling socket.

### Websocket payload

```jsonc
{
  "type": "inference",
  "session_id": "cam-01",
  "seq": 412,
  "frame": { "w": 640, "h": 480 },
  "objects": [{ "label": "laptop", "conf": 0.87, "box": [x, y, w, h] }],
  "faces": [{
    "name": "Ali Jaafar",
    "similarity": 0.61,
    "box": [x, y, w, h],
    "distance_m": 0.72, "distance_method": "ipd",
    "emotion": { "label": "Happy", "conf": 0.93, "derived": false, "scores": { "...": 0.0 } }
  }],
  "people": [{
    "id": 3, "age_s": 12.4,
    "box": [x, y, w, h], "body_box": [x, y, w, h], "face_box": [x, y, w, h],
    "name": "Ali Jaafar", "similarity": 0.61,
    "distance_m": 0.72, "distance_method": "ipd",
    "emotion": { "label": "Happy", "conf": 0.93, "derived": false, "scores": {} },
    "confidence": 0.91, "has_face": true
  }],
  "texts": [{ "text": "hello", "conf": 0.91, "box": [x, y, w, h], "quad": [[x, y]] }],
  "audio": { "level": 0.07 },
  "latency_ms": 38.2,
  "end_to_end_ms": 61.4,
  "stats": { "capture_fps": 30, "inference_fps": 21, "frames_dropped": 1204 }
}
```

All boxes are `[x, y, width, height]` in **source-frame pixels**. Inference runs
on a downscaled copy, but every coordinate is mapped back before it leaves the
backend, so consumers only ever deal with one coordinate system. The TypeScript
definitions in `frontend/src/types.ts` mirror this contract exactly.

---

## Tuning

Everything is environment-driven; see `.env.example` for the annotated list. The
dials that matter:

| Symptom | Change |
| ------- | ------ |
| Latency above budget | Raise `INFERENCE_THREADS` toward `cores / MAX_WORKERS` (see below) |
| CPU pegged | Lower `MAX_WORKERS`, raise `OCR_EVERY_N`, or `OCR_ENABLED=0` |
| Small objects missed | Lower `DETECTOR_CONF` (raising `INFERENCE_MAX_SIDE` past 640 does nothing — see below) |
| Distances all wrong by one ratio | `CAMERA_HFOV_DEG` does not match the lens — calibrate it once |
| Wrong person recognised | Raise `FACE_MATCH_THRESHOLD` toward 0.45 |
| Known person shows Unknown | Lower toward 0.30, or add more reference photos |
| OCR misses small text | Raise `OCR_INPUT_WIDTH`/`HEIGHT` (multiples of 32) |

### `INFERENCE_MAX_SIDE` does not speed up object detection

Measured per stage against a live 640x480 webcam on an 8-core CPU:

| inference input | detector | faces + emotion |
| --- | --- | --- |
| 640x480 | 132.7 ms | 62.5 ms |
| 480x360 | 130.9 ms | 59.3 ms |
| 384x288 | 132.9 ms | 50.3 ms |

The detector is flat. YOLOv8n is exported here with `imgsz=640, dynamic=False`,
so the network always runs at 640x640 — downscaling the frame just means the
letterbox pads more black. `INFERENCE_MAX_SIDE` only helps the face stage.

**The dial that actually moves object detection is `INFERENCE_THREADS`:**

| threads | detector |
| --- | --- |
| 1 | 223.6 ms |
| 2 | 135.1 ms |
| 4 | 100.2 ms |
| 6 | 87.8 ms |
| 8 | 174.8 ms ← oversubscribed on 8 cores |

Keep `MAX_WORKERS x INFERENCE_THREADS` at or just under the core count. On 8
cores, `MAX_WORKERS=2 INFERENCE_THREADS=4` took end-to-end from 233 ms to
193 ms; going to 6 threads made it worse, because OCR runs concurrently.

To get the full pipeline under 150 ms you have to make the detector itself
cheaper — re-export YOLOv8n at a smaller fixed size
(`docker compose build --build-arg YOLO_IMGSZ=416 backend`, requires registry
access) or drop it. **Without object detection the pipeline is far under
budget**: faces + distance + emotion measured **80 ms end-to-end at 16 fps**
(`DETECTOR_ENABLED=0`).

GPU: rebuild with `ONNXRUNTIME_PACKAGE=onnxruntime-gpu` and a CUDA base image.
Object detection moves to CUDA automatically — the detector prefers
`CUDAExecutionProvider` whenever it is installed. The OpenCV-driven stages stay
on CPU.

---

## Security

The defaults assume a single-user machine. Every one of them can be widened, and
each carries a note about what you are trading away when you do.

### Defaults

| Control | Default | Why |
| --- | --- | --- |
| Backend bind | `127.0.0.1` | The API is unauthenticated out of the box; `0.0.0.0` published a camera feed and an SSRF-capable endpoint to the whole LAN. |
| Frontend bind | `127.0.0.1` | nginx proxies `/api` and `/ws`, so a wider bind re-exposes the backend regardless of its own bind. |
| Auth | off (`OPENCAM_API_TOKEN` empty) | Keeps the local flow one command. Set it for anything else. |
| CORS | `http://localhost:5173`, `http://127.0.0.1:5173` | `*` plus no auth let **any page the user visited** drive this API. |
| Ingest schemes | `rtsp,rtsps,rtmp,rtmps,https` | `file` and `device` read local resources; `http` is cleartext. Add deliberately. |
| Ingest addresses | public only | Blocks loopback, private, link-local, multicast and reserved ranges. |
| Sessions / viewers / sockets | 16 / 8 / 16 | Each costs a peer connection and CPU; unbounded creation is a trivial DoS. |
| Container | non-root, `cap_drop: ALL`, `no-new-privileges`, read-only rootfs | Standard containment. |

### Turning on authentication

```bash
echo "OPENCAM_API_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Every `/api` route except `/api/health` (the Docker probe needs it) then requires
`Authorization: Bearer <token>`, and the metadata websocket requires it too:

```ts
const cam = new OpenCam({ url, sessionId, token: '<token>' });
```

Comparison is constant-time. The websocket accepts `?token=` because browsers
cannot set headers on a WebSocket handshake — so treat the token as a
session-scoped secret; it can land in proxy and server logs.

### SSRF — the sharpest edge

`POST /api/ingest` hands a URL to ffmpeg. Unrestricted, that is a server-side
request forgery primitive: it can fetch `http://169.254.169.254/` (cloud
instance metadata, often credentials), probe `127.0.0.1` for services that trust
loopback, and sweep the private network — with results readable through timing
and error text.

The guard resolves the hostname and rejects the request if **any** resolved
address is loopback, private, link-local, multicast or reserved. Every address
is checked, not just the first, so a hostname answering with both a public and a
private record is not a bypass. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is
unwrapped and re-checked. Resolution runs through the event loop's resolver with
a 5 s timeout — a blocking lookup here would stall every other request. On the
ffmpeg side, `protocol_whitelist` and disabled redirects stop a redirect
escaping the scheme policy. Failures return a generic message; the detail goes
to the log so the response cannot be used as a probing oracle.

This is defence in depth, not a proof — it cannot close the TOCTOU window
between our resolution and ffmpeg's. On a hostile network set `INGEST_ENABLED=0`.

`INGEST_ALLOW_PRIVATE=1` disables the address check entirely. It is the right
setting for a rack of IP cameras on a trusted VLAN and the wrong setting
anywhere else.

### Exposing it beyond localhost

Do all four, not some:

1. `OPENCAM_API_TOKEN` set to a random 32-byte value.
2. TLS in front — `getUserMedia` requires a secure context anyway.
3. `CORS_ALLOW_ORIGINS` naming your real origin, never `*`.
4. `BACKEND_HOST` / `FRONTEND_BIND` widened only as far as needed.

### What is not covered

- **No per-session authorisation.** Any caller holding the token can publish to,
  view or delete any `session_id`. Sessions are a namespace, not a security
  boundary.
- **No rate limiting.** The caps bound concurrent resources, not request rate.
  Put a reverse proxy in front if that matters.
- **`faces/` holds biometric data.** It is mounted read-only and gitignored, but
  it is plain files on disk — protect it like any other personal data.
- **Media is not end-to-end encrypted.** WebRTC encrypts each hop (DTLS-SRTP);
  the backend necessarily sees plaintext frames.

---

## Networking

Both services use `network_mode: host`, deliberately. aiortc gathers ICE
candidates from the interfaces it can see; inside a bridge network those are
unreachable `172.x` addresses and media never flows without a TURN relay. Host
networking gives the browser directly reachable candidates and removes a NAT hop
from the media path.

On macOS/Windows, or to serve remote browsers, switch to the bridge
configuration documented at the bottom of `docker-compose.yml` and run coturn.

---

## Layout

```
docker-compose.yml          host-networked stack, all tuning surfaced as env
.env.example                every knob, annotated
faces/                      reference photos (read-only mount, hot-reloaded)
backend/
  main.py                   FastAPI: WHIP, watch, websocket, introspection
  webrtc_manager.py         session lifecycle, media graph, annotated track
  pipeline/
    vision_engine.py        single-slot scheduling, worker pool, model bundles
    detector.py             YOLOv8 ONNX + letterbox + NMS
    face_matcher.py         YuNet detect, SFace embed, cosine gallery match
    emotion.py              FER classifier + Thinking heuristic
    ocr_engine.py           DB detection + CRNN recognition
    distance.py             pinhole distance from IPD / class-size priors
    people.py               body+face fusion and cross-frame id tracking
  utils/
    config.py               env-driven settings
    drawing.py              allocation-conscious OpenCV annotation
    fetch_models.py         build-time model fetch (git-lfs aware)
example-react/               runnable React examples, one file per feature
  run.sh                    one-shot `docker run --rm` dev server on :5174
  src/registry.ts           filesystem discovery of examples + ?raw source
  src/examples/             14 self-contained pages
packages/
  opencam-client/           the importable SDK (TypeScript + React bindings)
    src/opencam.ts          the OpenCam class: lifecycle, get(), getVideo(), events
    src/snapshot.ts         selector table behind get()
    src/sources.ts          camera / screen / file / element / stream / url
    src/overlay.ts          canvas annotation, letterbox-matched to the video
    src/react/index.tsx     provider, hooks, <OpenCamVideo>
frontend/
  src/
    types.ts                the wire contract, in one place
    hooks/useWebRTC.ts      publisher + viewer negotiation
    hooks/useWebSocket.ts   reconnecting metadata socket + log derivation
    components/             Streamer, Viewer, CanvasOverlay, Logs, StatsBar, SessionBar
```

---

## Troubleshooting

**“no active publisher for this session yet”** — the annotated track only exists
once someone is publishing. Go live first, then switch to Server rendered.

**Camera works, no detections** — check `GET /api/config`. If a capability is
`false`, its model failed to load; `docker compose logs backend` names the file.

**Nobody is ever recognised** — `docker compose logs backend | grep -i face`.
Reference photos with no detectable face are skipped with a warning.

**Video connects then dies** — almost always ICE. Confirm host networking is in
effect (`docker inspect opencam-backend | grep NetworkMode`), and remember that
a browser on a different machine needs TURN.

**High latency with everything else fine** — watch `frames_dropped`. If it is
near zero while `end_to_end_ms` is high, the bottleneck is a single slow
inference pass, not scheduling. Raise `INFERENCE_THREADS` (not
`INFERENCE_MAX_SIDE` — see the tuning section for why that does nothing for the
detector).
