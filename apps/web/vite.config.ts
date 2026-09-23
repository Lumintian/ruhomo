import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the Worker runs under `wrangler dev` on :8787; the Vite dev
// server proxies API and recipe routes to it. Production serves the built
// files as Worker static assets from the same origin.
const backend = process.env.RUHOMO_BACKEND ?? 'http://127.0.0.1:8787';
const basePath = process.env.RUHOMO_BASE_PATH ?? '/';
if (!basePath.startsWith('/') || !basePath.endsWith('/')) {
  throw new Error('RUHOMO_BASE_PATH must start and end with /');
}
const proxy = {
  target: backend,
  rewrite: (path: string) => path.slice(basePath.length - 1),
};

export default defineConfig({
  plugins: [react()],
  base: basePath,
  server: {
    proxy: {
      [`${basePath}api/`]: proxy,
      [`${basePath}r/`]: proxy,
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
