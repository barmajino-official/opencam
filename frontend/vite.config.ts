import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev proxy exists only for `npm run dev` outside Docker. In the shipped
// container Nginx performs the same /api and /ws proxying (see nginx.conf).
const backend = process.env.VITE_BACKEND_ORIGIN ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      // The websocket proxy needs a ws:// target and must NOT rewrite the
      // Origin header. With an http:// target plus changeOrigin the upgrade
      // silently never completes: the socket sits in CONNECTING forever, with
      // no error and no close event to notice it by.
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
