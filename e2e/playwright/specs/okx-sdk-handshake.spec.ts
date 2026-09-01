import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';
import { onboardOkx } from '../onboard-okx';

/**
 * Iteration 3 of the OKX E2E pipeline: SDK ↔ OKX handshake.
 *
 * OKX is a multi-chain wallet but the Bitcoin path follows a
 * single-address-per-wallet contract (like Unisat / Wizz). The SDK
 * connector populates both paymentAddress and ordinalsAddress from
 * the same Bitcoin address; we assert the BIP-84 derivation for the
 * abandon-seed.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

// OKX defaults to BIP-86 Taproot for its active `window.okxwallet.bitcoin`
// provider (the user picks the type in settings — Taproot is the
// default for a fresh restore). Our connector mirrors that single
// address into both paymentAddress and ordinalsAddress.
const EXPECTED_PAYMENT_ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `okx-handshake-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`OKX extension not unpacked at ${EXT_PATH}.`);
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
      // OKX anti-automation: hide navigator.webdriver.
      '--disable-blink-features=AutomationControlled',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  // Prefer the auto-opened chrome-extension onboarding tab; fall back
  // to manual newPage if OKX didn't auto-open one.
  let onboardPage: Page;
  try {
    onboardPage = await context.waitForEvent('page', {
      predicate: p => p.url().startsWith(`chrome-extension://${extensionId}`),
      timeout: 15_000,
    });
  } catch {
    onboardPage = await context.newPage();
  }
  test.setTimeout(180_000);
  const dashboard = await onboardOkx(onboardPage, extensionId);
  await shot(dashboard, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('okxConnector.connect via the harness page returns the BIP-86 mainnet Taproot address for the test seed', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const knownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOkx());
  resultPromise.catch(() => undefined);

  // OKX's approval surface — try URL-anchor first, then fall back to
  // a generic "Connect/Approve" button on any new chrome-extension page.
  const approval = await waitForApprovalPopup({
    context,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first()
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await shot(approval, '01-approval');
  await approval.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first().click();

  const info = await resultPromise;
  // eslint-disable-next-line no-console
  console.log(`[okx:sdk-handshake] paymentAddress = ${info.paymentAddress}`);

  expect(info.signingSupported).toBe(true);
  expect(info.paymentAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  // OKX single-address contract: ordinalsAddress mirrors payment.
  expect(info.ordinalsAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
});
