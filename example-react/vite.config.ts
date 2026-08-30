import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The examples talk to the backend by ABSOLUTE url (see `src/App.tsx`), not
 * through a dev proxy.
 *
 * A `server.proxy` entry with `ws: true` was the obvious choice, but Vite's dev
 * proxy never completes the websocket upgrade — the socket sits in CONNECTING
 * with no error and no close event, so the page looks connected while no
 * inference ever arrives. Verified against this backend: direct works, nginx
 * works, Vite times out.
 *
 * Going cross-origin is also the honest demonstration: an app on :5174 talking
 * to a backend on :8081 is exactly the deployment the SDK is built for, and it
 * exercises the CORS allowlist rather than hiding it.
 */
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5174 },
  build: { target: 'es2022' },
});
