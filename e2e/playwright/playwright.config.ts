import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { E2E_TIMEOUT_ENV } from '../e2e-timeout';

/**
 * The per-wait bound (TESTING.md): every assertion, `expect.poll`, action,
 * navigation and page event, and, through ORDPOOL_E2E_TIMEOUT_MS, every SDK
 * polling helper (electrs, ord, bitcoind, a wallet's service worker). A state
 * that needs longer to arrive is a defect in the app, the harness or the
 * helper, fixed there, never by raising this bound.
 */
const WAIT_TIMEOUT_MS = 30_000;
process.env[E2E_TIMEOUT_ENV] = String(WAIT_TIMEOUT_MS);

/**
 * The per-test bound. A test is a sequence of waits, not one wait.
 * Twice the longest green test: 216 s, xverse-inscribe-child-roundtrip in ordpool-sdk run 38066808952.
 */
const TEST_TIMEOUT_MS = 450_000;

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
  // Zero. A retry converts a defect into a quieter lane, and every one this
  // suite has hidden turned out to be a located cause rather than noise: a
  // closing popup accepted as an approval, a wait satisfied by a placeholder,
  // a seed path moved under a consumer. A cell that needs a retry is an open
  // question, and the lane should say so on the first run.
  retries: 0,
  timeout: TEST_TIMEOUT_MS,
  expect: {
    timeout: WAIT_TIMEOUT_MS,
  },
  use: {
    actionTimeout: WAIT_TIMEOUT_MS,
    navigationTimeout: WAIT_TIMEOUT_MS,
    headless: false,              // chromium extensions require headed mode
    screenshot: 'on',             // every test, including passing ones, so CI artifacts show progress
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
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
    timeout: WAIT_TIMEOUT_MS,
  },
});
