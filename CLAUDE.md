# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The hard constraint: nothing runs on the host

This project is **strictly Dockerized** by design, not by convention. There is no
virtualenv, no host `python`, no host JS toolchain, and no setup script. Every
tool you need runs in a container.

Do **not** run installs, builds, `python main.py`, or `tsc` on the host. Use
`docker compose` or an ephemeral `docker run --rm`.

**JavaScript tooling is bun, not npm.** The frontend image, the SDK package and
the compose `sdk` service all use `oven/bun:1-alpine`. Use `bun install`,
`bun run <script>`, `bun pm pack` — `bun install` on this repo takes ~4 s where
npm took minutes, and it is the slowest step in the compose build. Do not
reintroduce `npm`/`package-lock.json`; the lockfile here is `bun.lock`.

```bash
docker compose up --build          # first build ~5-10 min (models baked into the image)
docker compose up -d               # subsequent starts
docker compose logs -f backend     # backend log, incl. per-stage model load results
docker compose down
```

Frontend at <http://localhost:5173>; session id lives in the URL hash
(`#/cam-01`), so open a second tab on `#/cam-02` to exercise multi-session.

### Building the SDK

`packages/opencam-client` is a published-style npm package, built in a container
like everything else. A `sdk` compose service exists for it, behind the `tools`
profile so it never starts with `docker compose up`:

```bash
docker compose run --rm sdk bun install
docker compose run --rm sdk bun run build     # tsc -p tsconfig.build.json -> dist/
docker compose run --rm sdk bun run typecheck
docker compose run --rm sdk bun pm pack       # -> opencam-client-1.0.0.tgz
```

The `sdk` service uses `network_mode: host` and mounts the host's
`/etc/resolv.conf`. That is not cosmetic: this machine's DNS is systemd-resolved
on `127.0.0.53`, so a bridged container is handed nameservers it cannot route to
and every dependency install fails to resolve. A bare
`docker run oven/bun:1-alpine bun install` will fail here for that reason — add
`--network host -v /etc/resolv.conf:/etc/resolv.conf:ro`.

Note the same trap as the image builds: `docker run ... sh -c '...; bun run
build'` exits 0 even when the build failed. Echo and read the real exit code.

**`docker build` on this machine cannot reach the npm registry at all.** Its
sandbox gets nameservers `1.1.1.1`/`8.8.8.8` that it has no route to, so
`RUN bun install` inside a Dockerfile fails with `ConnectionRefused` — verified
with a minimal probe image, and it fails identically under npm, so it is not a
bun problem and `--network host` does not fix it. Consequence: **the frontend
image cannot currently be rebuilt from source on this host.** The `docker run`
path above works and is how to verify a frontend change:

```bash
docker run --rm --network host -v /etc/resolv.conf:/etc/resolv.conf:ro \
  -v "$PWD/frontend:/app" -w /app oven/bun:1-alpine \
  sh -c 'bun install && bun run build'
```

Both `bun.lock` files are committed and the Dockerfiles install with
`--frozen-lockfile`, so once egress is restored the image build reproduces the
exact tree verified this way. Clean up the root-owned `node_modules` a
`docker run` leaves behind with
`docker run --rm --user root -v "$PWD:/w" alpine rm -rf /w/frontend/node_modules`.

### Ephemeral-container recipes

```bash
# Typecheck the frontend (see the DNS note above for the two extra flags)
docker run --rm --network host -v /etc/resolv.conf:/etc/resolv.conf:ro \
  -v "$PWD/frontend:/app" -w /app oven/bun:1-alpine \
  sh -c 'bun install && bun run typecheck'

# Inspect the baked models
docker run --rm --entrypoint sh opencam-backend:1.0.0 -c 'ls -lh /models'

# Poke the backend without a browser (host networking => plain loopback)
curl -s localhost:8081/api/config | python3 -m json.tool
curl -s localhost:8081/api/sessions
curl -X DELETE localhost:8081/api/sessions/cam-01     # clear a stale session
```

### Testing

**There is no test suite, no linter, and no formatter config.** The single
automated gate is `tsc --noEmit`, run as the first half of `bun run build` inside
`frontend/Dockerfile` — a TypeScript error fails the image build rather than
shipping broken JS. Keep it that way; don't relax `tsconfig.json`'s strict flags
(`noUncheckedIndexedAccess` in particular) to make an edit compile.

The SDK has its own strict `tsc` gate (`docker compose run --rm sdk bun run
typecheck`), stricter than the frontend's: it also sets
`exactOptionalPropertyTypes`. Run it after touching `packages/opencam-client`.

Backend changes are verified by running the stack and reading
`GET /api/config` (which stages actually loaded) plus the live telemetry bar.

### Local port override

`.env` (gitignored) moves the backend to **8081**, because port 8080 on this
machine is held by an unrelated long-running container. `BACKEND_UPSTREAM`
follows it, so the frontend URL is unchanged. `.env.example` still documents
8080 as the default — don't "fix" the discrepancy.

---

## Architecture

Read `README.md` for the product-level tour. What follows is the part that only
becomes visible after reading several files at once.

### Media graph (`backend/webrtc_manager.py`)

One `Session` per `session_id`, each owning its own peer connections, its own
`VisionEngine`, and its own websocket fan-out. Two `MediaRelay` instances sit in
the graph and both are load-bearing:

- **ingress relay** — lets the inference consumer and the annotation track pull
  the *same* inbound track without stealing frames from each other.
- **egress relay** — fans the *already-annotated* track out to N viewers, so ten
  viewers cost one annotation pass, not ten.

`AnnotatedVideoTrack.recv()` copies `pts`/`time_base` from the source frame;
regenerating timestamps desyncs the relayed audio.

Signalling is **single-shot SDP, non-trickle**: aiortc completes ICE gathering
inside `setLocalDescription`, and the browser waits for
`iceGatheringState === 'complete'` (3 s fallback in `useWebRTC.ts`) before
POSTing. There is no signalling socket — don't add one.

### Scheduling (`backend/pipeline/vision_engine.py`)

Three invariants that changes tend to break:

1. **Single-slot register, never a queue.** `submit()` overwrites whatever frame
   is pending. Worst-case lag is one inference pass, forever. A FIFO here makes
   latency grow without bound the moment inference is slower than the camera.
   Rising `frames_dropped` is the mechanism working, not a bug.
2. **Pace before taking, not after.** `_main_worker` sleeps out the pacing gap
   *then* calls `_take_slot()`, so it always picks up the freshest frame.
3. **`wants_frame()` is checked before frame→ndarray conversion**, in the track
   consumer. That conversion costs real milliseconds at 720p; skipping the work
   before doing the work is where a chunk of the latency budget comes from.

OCR runs on a **separate worker at 1/N cadence** (`OCR_EVERY_N`) with its result
carried forward under `ANNOTATION_TTL_MS`, and deliberately on the
**full-resolution** frame (at 640px small scene text is unreadable). A slow text
pass must never be able to stall the fast path.

### Model-bundle pool — thread safety

`ModelBundle` holds one complete set of models and is **not** thread-safe:
`cv2.dnn.Net.forward` is not re-entrant. `InferenceRuntime` therefore keeps a
LifoQueue pool of bundles sized to match the `ThreadPoolExecutor`, and every
inference call must go through `runtime.lease()`. Never share a bundle across
workers, and never resize the pool independently of `MAX_WORKERS` — each bundle
is ~250 MB RSS, which is what makes `MAX_WORKERS` the dominant memory dial.

The pool is process-wide and shared by all sessions on purpose: five idle
sessions cost nothing, and five busy sessions degrade by dropping more frames
rather than by thrashing the CPU.

### Distance and people (`pipeline/distance.py`, `pipeline/people.py`)

Distance is the pinhole model plus a **metric prior** — a monocular image has no
scale on its own. Faces use interpupillary distance (63 mm, tight variance) and
are trustworthy to about ±10%; objects use per-class height priors and are
order-of-magnitude hints, tagged `distance_method: 'class_prior'` so callers can
discard them. `CAMERA_HFOV_DEG` is the single calibration dial and every
estimate scales linearly with it.

`build_people()` fuses `person` detections with face records. It pairs them by
**containment, not IoU** — a face box is ~5% of a body box, so their IoU is near
zero even for a perfect match.

`PeopleTracker` is **per-session mutable state**. It lives on `VisionEngine`,
never on `ModelBundle`: bundles are pooled across all sessions and would fuse
ids between cameras. Mutating it from the worker thread is safe only because the
single-slot register guarantees one `_infer()` per session at a time.
`Session._close_publisher()` calls `engine.reset_tracking()` so ids do not carry
across a source change.

### Local capture devices

`device:///dev/video0` is a third source. ffmpeg's v4l2 demuxer wants a bare
device path, not a URL, so `start_ingest` strips the scheme and defaults
`format` to `v4l2`. The scheme is kept in the public form deliberately:
`_validate_ingest_url` rejects schemeless input, which is what stops the endpoint
being a blind file/SSRF primitive. The container needs
`--device /dev/video0 --group-add "$(getent group video | cut -d: -f3)"` — without
the group the non-root `opencam` user gets `EACCES` and ingest returns 409.

### Two ingest paths, one media graph

`Session.attach_track()` is shared by the WebRTC publisher and the server-side
`MediaPlayer` (`start_ingest`), so everything downstream — relays, inference,
annotation, viewers — is identical regardless of where the pixels came from.
`MediaPlayer`'s constructor blocks until the stream opens, so it runs in the
executor; an unreachable camera would otherwise stall the whole event loop.

`handle_watch(annotated=False)` (`?annotated=0`) hands out the clean inbound
video. It exists for server-ingested sources, where the browser has no local
copy of the source and "give me the unannotated feed" is otherwise unanswerable.

### Coordinate contract

Inference runs on a downscaled copy (`_downscale` → `INFERENCE_MAX_SIDE`), but
`_rescale()` maps every box and landmark back before it leaves the backend.
**Everything crossing the wire is `[x, y, w, h]` in source-frame pixels.**
Inference-scale coordinates must never escape `vision_engine.py`.

`frontend/src/types.ts` **and** `packages/opencam-client/src/types.ts` both
mirror the websocket payload. They and the backend's payload construction are
one contract in three files with nothing mechanical enforcing agreement — change
all three together.

### Graceful degradation

A missing or unloadable model sets `available = False` on its engine, logs a
warning, and drops out of `capabilities()`; `GET /api/config` reports it and the
dashboard greys out that layer. Stages **never** raise on missing models, and
`fetch_models.py` treats download failure as non-fatal. Preserve this: it's why
a partial build still produces a working demo.

### SDK (`packages/opencam-client`)

Two entry points: `.` (framework-free) and `./react`, so a non-React consumer
never pulls React into their bundle. React is an *optional* peer dependency.

Three design points that are easy to break:

1. **`get()` is a value-map lookup, not overloads.** `OpenCamValueMap` maps each
   key to its return type; `get<K extends keyof OpenCamValueMap>` gives per-key
   return types and autocomplete from one signature. `SELECTORS` in
   `snapshot.ts` is typed as a mapped type over that same map, so the compiler
   rejects a new key with no selector.
2. **Snapshots are frozen and replaced wholesale.** That makes the snapshot
   reference a valid "did anything change" test, which is what
   `useSyncExternalStore` needs. `react/index.tsx` memoises derived values in a
   `WeakMap<Snapshot, Map<key, value>>` — without it, selectors that build fresh
   arrays (`names`, `count`) would re-render forever.
3. **Emitted JS resolves at runtime, not through a bundler.** Every relative
   import in `src/` carries an explicit `.js` extension. Dropping one produces a
   package that typechecks and then fails to import.

The overlay reproduces the browser's `object-fit: contain` letterbox maths
exactly (`computeFit`). The video element must use `contain` or boxes drift.

### Examples app (`example-react/`)

A separate Vite app on :5174, run through `./example-react/run.sh` (a one-shot
`docker run --rm`), never built into an image — it is documentation that
executes.

- **Examples are discovered, not listed.** `src/registry.ts` uses
  `import.meta.glob` over `src/examples/*.tsx` plus a second `?raw` glob for the
  source text. Adding a file adds a menu entry, a route and a source panel; there
  is no registration list to update. Order comes from the numeric filename
  prefix, and the slug drops it (`02-objects.tsx` → `#/objects`).
- **The source viewer reads the real file**, so a snippet can never drift from
  the code beside it. Do not replace it with hand-copied strings.
- **Vite proxies `/api` and `/ws`**, so the page and API share an origin and CORS
  never enters the picture. That is why the examples pass no `url` to the SDK.
- **The container must mount the repo root**, not `example-react/`, because the
  app depends on `../packages/opencam-client` via `file:`. The SDK's `dist/` has
  to exist — build it first if it is missing.
- One `OpenCamProvider` wraps every page in `App.tsx` so switching examples does
  not tear down the camera; the multi-session page nests its own providers.

### Frontend

React 18 + TypeScript (strict) + Tailwind, Vite build, served by nginx which also
reverse-proxies `/api` and `/ws` (`frontend/nginx.conf`, templated with
`FRONTEND_PORT` / `BACKEND_UPSTREAM` via `NGINX_ENVSUBST_FILTER`).

Two display modes exist to expose a real trade-off:
- **Raw feed** — local camera + client-side SVG overlay. Zero added video
  latency; only JSON makes the round trip.
- **Server rendered** — second WebRTC stream with annotations baked into pixels.

The `Streamer` component stays **mounted but hidden** in server-rendered mode, so
switching never tears down the publishing `RTCPeerConnection`.

Overlay alignment depends on a matched pair: the SVG's
`viewBox="0 0 frameW frameH"` + `preserveAspectRatio="xMidYMid meet"` against the
`<video>`'s `object-fit: contain`. Both apply identical letterbox math. Change one
and boxes drift off the subject.

`useWebSocket.ts` logs **transitions only** (new class, identity change, new
text), tracked in `seenRef`, otherwise the console floods at 20 fps.

---

## Docker build gotchas

These were each paid for once; don't undo them.

- **`python:3.11-slim-bookworm` is pinned deliberately** in both stages. Bare
  `python:3.11-slim` now resolves to Debian 13 (trixie), where `libvpx7` does not
  exist and the runtime stage fails to install aiortc's codec libs.
- **torch and torchvision are both pinned from the CPU index** in one command.
  Pinning only torch lets pip resolve torchvision from PyPI, which pins a *CUDA*
  torch and silently pulls multiple GB of `nvidia-*` wheels.
- **Torch gets its own layer, above the `COPY fetch_models.py`.** Editing the
  fetch script must not trigger another 195 MB download. Keep that layer order.
- **ultralytics' `opencv-python` is swapped for `opencv-python-headless`** in the
  models stage; the GUI wheel links libGL/libxcb and fails to import on a slim
  base.
- **`CHARSET_EN_36` order is load-bearing.** Upstream opencv_zoo no longer ships
  a charset file, so `fetch_models.py` writes it locally. CTC decoding indexes
  into it directly (`charset[c - 1]`) — never sort or "tidy" it.
- Runtime stage runs as non-root (`opencam`, uid 10001) with a read-only
  filesystem in mind: don't add anything that writes outside `/tmp`.

## Networking

Both services use `network_mode: host` **on purpose**. Inside a bridge network
aiortc gathers unreachable `172.x` ICE candidates and media never flows without a
TURN relay. The bridge + coturn alternative is documented at the bottom of
`docker-compose.yml` for macOS/Windows/remote browsers.

`getUserMedia` needs a secure context: `http://localhost` qualifies, a bare LAN IP
does not. The permission prompt fires on the **● Go live** click (a user gesture),
never on page load.

## Configuration

Everything is env-driven through the frozen `Settings` dataclass in
`backend/utils/config.py`, surfaced in `docker-compose.yml` and annotated in
`.env.example`. Add new knobs there rather than hardcoding — and mirror the
default in all three places.

Latency dials, in order of measured effect: **`INFERENCE_THREADS`**, then
`DETECTOR_ENABLED`, then `MIN_INFERENCE_INTERVAL_MS`. The telemetry bar turns
amber above the 150 ms budget, red above 300 ms.

**`INFERENCE_MAX_SIDE` does not speed up object detection.** Profiled on a live
camera, the detector costs ~132 ms at 640, 480 *and* 384 input, because YOLOv8n
is exported with `imgsz=640, dynamic=False` and always runs at 640x640 —
downscaling only adds letterbox padding. It helps the face stage only
(62 -> 50 ms). The README's tuning table used to claim otherwise; it is corrected.

Thread scaling on 8 cores: 1 -> 223 ms, 2 -> 135 ms, 4 -> 100 ms, 6 -> 88 ms,
8 -> 175 ms (oversubscribed). Keep `MAX_WORKERS x INFERENCE_THREADS` <= cores.
`.env` here is set to `MAX_WORKERS=2 INFERENCE_THREADS=4`, measured at 193 ms
end-to-end versus 233 ms with the defaults. OCR contributes ~5 ms to end-to-end
(it runs on its own worker), so `OCR_EVERY_N` is not a latency dial — it is a
CPU-budget dial. Faces + distance + emotion alone (`DETECTOR_ENABLED=0`) measured
**80 ms end-to-end at 16 fps**, comfortably inside budget.

## Security model

Defaults assume a single-user machine, and several of them were tightened after
an audit; do not loosen one without reading why it is set.

- **Both services bind `127.0.0.1`.** The backend was `0.0.0.0` with no auth,
  publishing a camera API and an SSRF endpoint to the LAN. nginx binds loopback
  too (`FRONTEND_BIND`) because it proxies `/api` — a wide nginx bind defeats a
  narrow backend bind.
- **`utils/security.py`** holds auth and the SSRF guard, kept out of the app so
  both are testable in isolation.
- **Auth is opt-in** via `OPENCAM_API_TOKEN`; middleware in `main.py` gates
  `/api/*` (except `/api/health`, which the Docker probe calls unauthenticated)
  and the websocket. Use `hmac.compare_digest`, never `==` — a short-circuiting
  compare leaks the token prefix through timing.
- **SSRF guard checks every resolved address**, not just the first, and unwraps
  IPv4-mapped IPv6. DNS goes through `loop.getaddrinfo` with a timeout:
  `socket.getaddrinfo` is blocking, and calling it from a handler stalled the
  entire event loop for 30 s on a host with no DNS — a self-inflicted DoS that
  this code previously had.
- **Ingest errors are generic to the caller, detailed in the log.** ffmpeg's
  messages carry local paths and internal hostnames, and a verbatim response is
  a probing oracle.
- **`file` and `device` are not in the default scheme allowlist** — both read
  local resources.
- **Resource caps** (`MAX_SESSIONS`, `MAX_VIEWERS_PER_SESSION`,
  `MAX_SOCKETS_PER_SESSION`) are enforced *before* `websocket.accept()`: closing
  after the handshake looks like success to the client and invites a reconnect
  loop.
- **nginx `add_header` does not accumulate.** A single `add_header` in a
  `location` block silently discards every inherited security header, so cache
  policy there uses `expires` and `default_type` instead. Adding one
  `add_header` to a location will quietly drop the CSP.

## `faces/`

Real photographs of real people, mounted **read-only** at `/faces`. Gitignored
except `README.md` and `.gitkeep`. Filename is the label
(`Ali_Jaafar_2.png` → "Ali Jaafar"); subdirectories work too. Hot-reloaded on a
`FACE_RELOAD_INTERVAL_S` timer or via `POST /api/faces/reload`. Never write to
this directory, and never commit its contents.

## The "Thinking" emotion is derived, not predicted

The FER model has seven classes and thinking is not one of them. A
weakly-confident `neutral` with a pensive runner-up
(`sad`/`fearful`/`angry`) is relabelled "Thinking" and marked `derived: true`;
the full model distribution ships in every payload regardless. Disable with
`EMOTION_THINKING_HEURISTIC=0`. Don't present it as a model output.
