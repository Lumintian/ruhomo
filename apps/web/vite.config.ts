import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the Worker runs under `wrangler dev` on :8787; the Vite dev
// server proxies API and recipe routes to it. Production serves the built
// files as Worker static assets from the same origin.
const backend = process.env.RUHOMO_BACKEND ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': backend,
      '/r/': backend,
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
