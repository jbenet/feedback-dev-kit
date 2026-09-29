import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The example's end-to-end tests. Against a running server: BASE_URL=http://localhost:3172 and
 * FEEDBACK_DATA=<the folder that server writes to>. Without BASE_URL, Playwright builds and starts
 * the example itself on PORT (default 3172) with a fresh data folder.
 */
const port = Number(process.env.PORT ?? 3172);
if (!process.env.FEEDBACK_DATA) process.env.FEEDBACK_DATA = mkdtempSync(join(tmpdir(), 'fbk-e2e-'));

export default defineConfig({
  testDir: './e2e',
  // One server, one issue numbering: the tests run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? `http://localhost:${port}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: process.env.BASE_URL ? undefined : {
    command: `npm run build && npx next start -p ${port}`,
    url: `http://localhost:${port}`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { FEEDBACK_DATA: process.env.FEEDBACK_DATA!, NEXT_TELEMETRY_DISABLED: '1' },
  },
});
