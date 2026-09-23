import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;

// The backend is not started here: tests route /api and /r requests to an
// in-process instance of the real Worker app with a fake upstream, so no
// external network is used. Set PLAYWRIGHT_CHANNEL=chrome to use a system
// Chrome instead of the bundled Chromium.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    env: { RUHOMO_BACKEND: 'http://127.0.0.1:9' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
