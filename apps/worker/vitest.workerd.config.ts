import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs a smoke suite inside workerd (Miniflare) with the real Cache API and
// the real Worker entry, complementing the Node-based HTTP tests.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['test/workerd/**/*.test.ts'],
  },
});
