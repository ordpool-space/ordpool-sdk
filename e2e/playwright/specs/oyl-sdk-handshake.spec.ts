import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 3 of the Phantom E2E pipeline: SDK ↔ Phantom handshake.
 *
 * Phantom v26 returns BOTH a P2WPKH payment address and a P2TR
 * ordinals address from `btc_requestAccounts`. The SDK connector
 * splits them by `addressType`. Assert both derivations for the
 * abandon-seed.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/oyl');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const EXPECTED_PAYMENT_ADDRESS  = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const EXPECTED_ORDINALS_ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `oyl-handshake-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardOyl(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/tabs/index.html`, { waitUntil: 'domcontentloaded' });

  const importBtn = page.getByText(/import.*wallet|already have|recovery phrase|use seed/i).first();
  await expect(importBtn).toBeVisible({ timeout: 30_000 });
  await importBtn.click();

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

  const confirmAfterMnemonic = page.getByRole('button', { name: /^(confirm|continue|next|import|restore)$/i }).first();
  await expect(confirmAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await confirmAfterMnemonic.click();

  const pwInputs = page.locator('input[type="password"]');
  if (await pwInputs.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
    const pwCount = await pwInputs.count();
    for (let i = 0; i < pwCount; i++) {
      await pwInputs.nth(i).fill(TEST_PASSWORD);
    }
    const pwContinue = page.getByRole('button', { name: /^(confirm|continue|next|create|done|finish)$/i }).first();
    await expect(pwContinue).toBeEnabled({ timeout: 10_000 });
    await pwContinue.click();
  }

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('oyl');
  }, undefined, { timeout: 60_000, polling: 500 });
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Phantom extension not unpacked at ${EXT_PATH}.`);
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
  await onboardOyl(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('oylConnector.connect via the harness page returns the BIP-84 + BIP-86 mainnet addresses for the test seed', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const knownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectPhantom());
  resultPromise.catch(() => undefined);

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
  console.log(`[oyl:sdk-handshake] payment = ${info.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[oyl:sdk-handshake] ordinals = ${info.ordinalsAddress}`);

  expect(info.signingSupported).toBe(true);
  expect(info.paymentAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  expect(info.ordinalsAddress).toBe(EXPECTED_ORDINALS_ADDRESS);
  // Payment pubkey = compressed sec256k1 = 33 bytes = 66 hex.
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
  // Ordinals pubkey is x-only (32 bytes = 64 hex) — Phantom returns
  // compressed but the SDK normalises to x-only for consistency.
  expect(info.ordinalsPublicKey).toMatch(/^[0-9a-f]{64}$/);
});
