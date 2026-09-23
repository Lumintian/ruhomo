import { defineConfig, devices } from '@playwright/test';

const PORT = 5200;
const PREFIX = '/tools/ruhomo/';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'prefix.spec.ts',
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}${PREFIX}`,
    reuseExistingServer: !process.env.CI,
    env: { RUHOMO_BASE_PATH: PREFIX, RUHOMO_BACKEND: 'http://127.0.0.1:9' },
  },
  projects: [{ name: 'prefix', use: { ...devices['Desktop Chrome'] } }],
});
