import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { E2E_TIMEOUT_ENV } from '../e2e-timeout';

/**
 * The one timeout of this config (TESTING.md). It bounds the test, every
 * assertion and, with `actionTimeout` / `navigationTimeout` left unset, every
 * action and navigation, so any single wait may take as long as the test. The
 * SDK's polling helpers read the same value through ORDPOOL_E2E_TIMEOUT_MS.
 *
 * Sized for the slowest wallet roundtrip (onboard, connect, sign, mine and wait
 * for electrs and ord). A spec that needs longer is a defect in the app or the
 * harness, fixed there, never a per-spec bound.
 */
const TIMEOUT_MS = 600_000;
process.env[E2E_TIMEOUT_ENV] = String(TIMEOUT_MS);

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
  timeout: TIMEOUT_MS,
  expect: {
    timeout: TIMEOUT_MS,
  },
  use: {
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
    timeout: TIMEOUT_MS,
  },
});
