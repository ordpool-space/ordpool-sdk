import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { seedAlbyAccount } from '../onboard-alby';


/**
 * Pipeline B handshake for Alby: seed the wallet via SW messages
 * (the only mnemonic-import path Alby exposes — the UI is
 * Lightning-first and has no BIP-39 input flow), then drive
 * albyConnector.connect through the harness and assert the
 * returned address matches the canonical BIP-86 mainnet test
 * vector for our test seed.
 *
 * Seeds with bitcoinNetwork:"bitcoin" (mainnet) so the derivation
 * path is m/86'/0'/0'/0/0 — that's the BIP-86 vector our
 * EXPECTED_MAINNET_TAPROOT comes from. Different from the mint
 * roundtrip spec which uses bitcoinNetwork:"regtest" to enable
 * funding from a local bitcoind.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

// BIP-86 mainnet test-vector first address for the abandon×11+about
// seed at m/86'/0'/0'/0/0. Same value published in BIP-86's
// "Test vectors" → "Account 0, second receiving address" is bc1p4qhj...,
// but the FIRST receiving address (m/86'/0'/0'/0/0) is this one.
const EXPECTED_MAINNET_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

let context: BrowserContext;
let extensionId: string;
let seedPage: Page;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-handshake-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Alby extension not unpacked at ${EXT_PATH}. Run e2e/playwright/playwright-bootstrap.sh.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  seedPage = await context.newPage();
  // Alby's React welcome wizard on options.html calls window.close()
  // on first paint — block it so the seedPage survives the evaluate.
  // Scoped to seedPage only so Alby's permission/sign popups can
  // close themselves later.
  await seedPage.addInitScript(() => {
    try {
      Object.defineProperty(window, 'close', { value: () => undefined, writable: false, configurable: false });
    } catch { /* ignore */ }
  });
  await seedPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  await seedPage.waitForFunction(() => true, undefined, { timeout: 2_000 }).catch(() => undefined);

  test.setTimeout(180_000);
  await seedAlbyAccount(seedPage, { bitcoinNetwork: 'bitcoin' });
  await shot(seedPage, '00-after-seed');
});

test.afterAll(async () => {
  await context?.close();
});

test('albyConnector.connect via the harness page returns the BIP-86 mainnet Taproot address for the test seed', async () => {
  test.setTimeout(180_000);

  // alby.enable() opens a permission popup; auto-click any Alby
  // chrome-extension popup that has a Connect / Confirm button.
  // Wait out the lndhub-validation error toast (~6s) before
  // clicking so the click lands on the real button, not the toast.
  let popupCount = 0;
  context.on('page', async (popup) => {
    const idx = ++popupCount;
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      if (!popup.url().startsWith('chrome-extension://')) return;
      await shot(popup, `popup-${idx}-loaded`).catch(() => undefined);
      const btn = popup.locator('button', { hasText: /^(connect|allow|confirm|approve)$/i }).first();
      await btn.waitFor({ state: 'visible', timeout: 15_000 });
      // trial:true waits for full actionability (Alby's regtest error
      // toast stops intercepting the pointer) instead of a blind timeout.
      await btn.click({ trial: true, timeout: 15_000 });
      await btn.click({ timeout: 5_000 });
      // eslint-disable-next-line no-console
      console.log(`[alby-handshake] auto-clicked popup #${idx}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[alby-handshake] popup #${idx} skipped: ${String(e).slice(0, 120)}`);
    }
  });

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  const info = await harness.evaluate(() => window.ordpoolSdkHarness.connectAlby());
  // eslint-disable-next-line no-console
  console.log(`[alby-handshake] paymentAddress = ${info.paymentAddress}`);

  expect(info.paymentAddress).toBe(EXPECTED_MAINNET_TAPROOT);
  // Alby's webbtc.getAddress maps to both lanes — same Taproot
  // identity for payment and ordinals.
  expect(info.ordinalsAddress).toBe(EXPECTED_MAINNET_TAPROOT);
  expect(info.signingSupported).toBe(true);
});
