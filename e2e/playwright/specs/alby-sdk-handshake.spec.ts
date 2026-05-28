import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 3 of the OKX E2E pipeline: SDK ↔ OKX handshake.
 *
 * OKX is a multi-chain wallet but the Bitcoin path follows a
 * single-address-per-wallet contract (like Unisat / Wizz). The SDK
 * connector populates both paymentAddress and ordinalsAddress from
 * the same Bitcoin address; we assert the BIP-84 derivation for the
 * abandon-seed.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const EXPECTED_PAYMENT_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-handshake-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardOkx(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  // Alby's manifest has `options_ui: {page: "options.html", open_in_tab: true}`.
  // popup.html shows a placeholder; options.html is the actual onboard surface.
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });

  // Alby: passcode-first flow.
  await expect(page.getByText('Set extension unlock passcode', { exact: false })).toBeVisible({ timeout: 30_000 });
  const passcodeInputs = page.locator('input[type="password"]');
  await expect(passcodeInputs).toHaveCount(2, { timeout: 10_000 });
  await passcodeInputs.nth(0).fill(TEST_PASSWORD);
  await passcodeInputs.nth(1).fill(TEST_PASSWORD);
  const passcodeNext = page.getByRole('button', { name: /^next$/i });
  await expect(passcodeNext).toBeEnabled({ timeout: 10_000 });
  await passcodeNext.click();

  const seedRoute = page.getByText(/seed phrase|bring your own|advanced/i).first();
  await expect(seedRoute).toBeVisible({ timeout: 20_000 });
  await seedRoute.click();

  const mnemonicInputs = page.locator('input[type="text"], input[type="password"], textarea');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  const inputCount = await mnemonicInputs.count();
  if (inputCount >= 12) {
    for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
      await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
    }
  } else {
    await mnemonicInputs.first().fill(TEST_MNEMONIC);
  }
  const importBtn = page.getByRole('button', { name: /^(confirm|continue|next|import|restore|finish)$/i }).first();
  await expect(importBtn).toBeEnabled({ timeout: 15_000 });
  await importBtn.click();

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('account');
  }, undefined, { timeout: 60_000, polling: 500 });
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
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  const onboardPage = await context.newPage();
  test.setTimeout(180_000);
  await onboardOkx(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('albyConnector.connect via the harness page returns the BIP-84 mainnet address for the test seed', async () => {
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
  console.log(`[alby:sdk-handshake] paymentAddress = ${info.paymentAddress}`);

  expect(info.signingSupported).toBe(true);
  expect(info.paymentAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  // OKX single-address contract: ordinalsAddress mirrors payment.
  expect(info.ordinalsAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
});
