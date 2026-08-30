# OpenCam — React examples

A menu-driven tour of `@opencam/client`. Every page is one small, self-contained
file, and each shows **its own source** underneath the live demo — the code you
read is literally the code running above it.

## Run it

From a fresh clone, build the SDK first — this app depends on it by path, and
`dist/` is not committed:

```bash
docker compose run --rm sdk bun install
docker compose run --rm sdk bun run build
```

Then bring up the backend (from the repo root):

```bash
docker compose up -d
```

Then start this app in a throwaway container — nothing is installed on the host:

```bash
docker run --rm -it \
  --network host \
  -v /etc/resolv.conf:/etc/resolv.conf:ro \
  -v "$PWD:/repo" -w /repo/example-react \
  oven/bun:1-alpine \
  sh -c 'bun install && bun run dev'
```

Open **<http://127.0.0.1:5174>**.

Notes on that command:

- `-v "$PWD:/repo"` mounts the **repo root**, not just this folder, because the
  app depends on `../packages/opencam-client` via a `file:` reference.
- `--network host` puts the dev server on `127.0.0.1:5174` and lets it reach the
  backend on `127.0.0.1:8081`.
- `-v /etc/resolv.conf:...` is needed on this machine only: containers here are
  handed nameservers they cannot route to, so `bun install` fails without it.
- `--rm` deletes the container on exit. `node_modules` stays in the folder
  (gitignored) so the next start is instant.

Stop with `Ctrl-C`.

### It talks to the backend cross-origin

The app runs on `:5174` and calls the backend on `:8081` by absolute URL, so
the backend's `CORS_ALLOW_ORIGINS` must include this origin. It does by default:

```
CORS_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174
```

A Vite dev proxy would have avoided CORS, and that is what this used to do — but
Vite's proxy never completes the WebSocket upgrade. The socket sits in
`CONNECTING` with no error and no close event, so the page looks fine while no
inference ever arrives. Direct works, nginx works, Vite times out. Going
cross-origin is also the honest demo: an app on one port talking to a backend on
another is the deployment the SDK is built for.

Point somewhere else with:

```bash
-e VITE_OPENCAM_URL=http://127.0.0.1:9000
```

### One session per tab

Each tab picks its own `sessionId` (stored in `sessionStorage`, shown under the
page title). This matters: publishing to a session that already has a publisher
**replaces** it, so a fixed id makes two tabs silently evict each other — each
sees a black video with the other's detections drawn on top.

## The examples

| # | Page | Shows |
| --- | --- | --- |
| 01 | Quick start | init → start → `get()`; why the prompt needs a click |
| 02 | Object detection | `get('objects')`, boxes in source-frame pixels |
| 03 | Face recognition | identities, similarity, live `/faces` rescan |
| 04 | Distance | `get('distance')` and a calibration helper |
| 05 | Emotion | winning label plus the full model distribution |
| 06 | Text / OCR | `get('text')` and why it updates more slowly |
| 07 | People tracking | fused body+face records, stable ids, enter/leave |
| 08 | Sources | camera, screen, file, URL, RTSP, `device://` |
| 09 | Video modes | clean vs client overlay vs server-composited |
| 10 | Overlay options | layer toggles, colours, mirroring |
| 11 | Events | push instead of poll, without re-rendering |
| 12 | Telemetry | latency budget, and why dropped frames are correct |
| 13 | Multi-session | independent sessions sharing one compute budget |
| 14 | Snapshot inspector | every `get()` key, live, with real shapes |

## Adding one

Drop a file into `src/examples/`:

```tsx
export const meta = { title: 'My example', blurb: 'What it shows.' };

export default function MyExample() {
  return <div>…</div>;
}
```

That is the whole registration step. `src/registry.ts` discovers files with
`import.meta.glob`, so the menu, the route and the source viewer all pick it up
with no other edit. Ordering follows the numeric filename prefix.

## Layout

```
src/
  App.tsx              layout + hash routing; one OpenCamProvider for all pages
  registry.ts          filesystem discovery + ?raw source loading
  components/
    Shell.tsx          sidebar menu
    CodeBlock.tsx      collapsible source viewer
    ui.tsx             Stat / Row / Empty / LiveControls
  examples/            one file per example — the interesting part
```

## Typecheck

```bash
docker run --rm --network host -v /etc/resolv.conf:/etc/resolv.conf:ro \
  -v "$PWD:/repo" -w /repo/example-react oven/bun:1-alpine \
  sh -c 'bun install && bun run typecheck'
```
