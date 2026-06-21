import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

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
  timeout: 600_000,
  expect: {
    timeout: 20_000,
  },
  use: {
    headless: false,
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  outputDir: path.resolve(__dirname, '../../test-results'),
  webServer: {
    command: 'node fixtures-server.js',
    cwd: __dirname,
    port: 4500,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
