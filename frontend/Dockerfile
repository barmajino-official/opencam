# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# Stage 1 - build the Vite/TypeScript bundle
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS build

WORKDIR /app
ENV CI=1

# Dependency layer is cached independently of source changes. bun resolves and
# links this tree several times faster than npm, which matters because it is the
# slowest step in the whole compose build.
# The lockfile is copied alongside package.json so the image build resolves the
# exact tree that was verified locally, rather than whatever is newest today.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src

# `bun run build` runs `tsc --noEmit` first: a type error fails the image build
# rather than shipping broken JavaScript. Vite itself still runs on the bundled
# Node-compatible runtime, so the emitted bundle is byte-for-byte what npm gave.
RUN bun run build

# ---------------------------------------------------------------------------
# Stage 2 - serve + reverse proxy
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

ENV FRONTEND_PORT=5173 \
    BACKEND_UPSTREAM=127.0.0.1:8080 \
    # Restrict envsubst to our own variables, otherwise it would eat nginx's
    # own $host / $remote_addr / $upstream_* placeholders.
    NGINX_ENVSUBST_FILTER='^(FRONTEND_PORT|BACKEND_UPSTREAM)$'

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 5173

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${FRONTEND_PORT}/healthz" || exit 1
