import { defineConfig } from 'vitest/config';

// Real-kernel suite. Run with `pnpm test:integration`, which first fetches
// and verifies the pinned Mihomo binary (scripts/fetch-mihomo.mjs).
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
