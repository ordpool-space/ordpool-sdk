import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

/**
 * Playwright config for the Xverse-extension E2E suite.
 *
 * The suite runs ONLY in CI (xvfb + headed Chromium) — never on
 * dev machines, because Xverse's .crx is unverified-binary code
 * that we don't want loading into the dev profile. CI gets a
 * fresh container per run.
 */
export default defineConfig({
  testDir: path.resolve(__dirname, 'specs'),
  globalSetup: path.resolve(__dirname, 'global-setup.ts'),
  fullyParallel: false,           // extension state is shared across specs
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 20_000,
  },
  use: {
    headless: false,              // chromium extensions require headed mode
    screenshot: 'on',             // every test, including passing ones, so CI artifacts show progress
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  outputDir: path.resolve(__dirname, '../../test-results'),
  reporter: [
    ['list'],
    ['html', {
      open: 'never',
      outputFolder: path.resolve(__dirname, '../../playwright-report'),
    }],
  ],
  // Serves the SDK harness page (HTML + bundled connector/signer/
  // helper code) over http://localhost:4500. Xverse's content
  // script only injects on http(s) origins, so file:// won't work.
  webServer: {
    command: 'node fixtures-server.js',
    cwd: __dirname,
    port: 4500,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
