#!/bin/sh
# Start the examples app in a throwaway container. Run from the repo root.
#
#   ./example-react/run.sh
#
# The repo ROOT is mounted because this app depends on
# ../packages/opencam-client through a `file:` reference.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)

exec docker run --rm -it \
  --network host \
  -v /etc/resolv.conf:/etc/resolv.conf:ro \
  -v "$ROOT:/repo" \
  -w /repo/example-react \
  oven/bun:1-alpine \
  sh -c 'bun install && bun run dev'
