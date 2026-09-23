import { defineConfig } from 'vitest/config';

// Unit and HTTP tests that run in Node. The real-Mihomo suite lives in
// tests/integration (pnpm test:integration) and the workerd smoke test in
// apps/worker (pnpm test:workerd).
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/worker/test/**/*.test.ts'],
    exclude: ['apps/worker/test/workerd/**', '**/node_modules/**'],
    environment: 'node',
  },
});
