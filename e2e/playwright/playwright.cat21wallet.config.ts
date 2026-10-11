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
 * Cat21 Wallet-only Playwright config — runs the three transfer /
 * createOffer / acceptOffer roundtrip specs against the regtest
 * stack WITHOUT the Xverse globalSetup gate. The default config's
 * globalSetup primes an Xverse seed cache and refuses to start if
 * the Xverse `.crx` isn't unpacked; these specs don't need Xverse,
 * so we ship a parallel config that omits the gate. CI workflows
 * keep using the default config; this one is for targeted local
 * runs while developing or auditing the wallet's cat21 flows.
 */
export default defineConfig({
  testDir: path.resolve(__dirname, 'specs'),
  // No globalSetup — these specs are self-contained against the
  // local regtest stack + the Cat21 Wallet `.crx` already unpacked
  // at e2e/extensions/cat21wallet/.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: TEST_TIMEOUT_MS,
  expect: {
    timeout: WAIT_TIMEOUT_MS,
  },
  use: {
    actionTimeout: WAIT_TIMEOUT_MS,
    navigationTimeout: WAIT_TIMEOUT_MS,
    headless: false,
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: path.resolve(__dirname, '../../test-results'),
  webServer: {
    command: 'node fixtures-server.js',
    cwd: __dirname,
    port: 4500,
    reuseExistingServer: true,
    timeout: WAIT_TIMEOUT_MS,
  },
});
