import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 4 of the Oyl E2E pipeline: matrix spec.
 *
 * Unlike Unisat/Wizz (single-address-per-active-type), Oyl
 * returns BOTH derivations on every connect — `getAddresses()`
 * yields `{nativeSegwit, taproot}`. So this matrix is two
 * assertions inside a SINGLE onboarded context, not separate
 * onboarding runs per variant: the wallet doesn't change state
 * between assertions, only the connector lane being checked.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/oyl');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

interface OylAddressVariant {
  label: string;
  walletField: 'paymentAddress' | 'ordinalsAddress';
  expectedAddress: string;
}

const VARIANTS: ReadonlyArray<OylAddressVariant> = [
  {
    label: 'P2WPKH (BIP-84 Native SegWit)',
    walletField: 'paymentAddress',
    expectedAddress: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  },
  {
    label: 'P2TR (BIP-86 Taproot)',
    walletField: 'ordinalsAddress',
    expectedAddress: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
  },
];

let context: BrowserContext;
let extensionId: string;
let onboardedDashboard: Page | null = null;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `oyl-matrix-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardOyl(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/tabs/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByText('Import wallet', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByText('Import wallet', { exact: true }).click();

  const mnemonicInputs = page.locator('#word-0, #word-1, #word-2, #word-3, #word-4, #word-5, #word-6, #word-7, #word-8, #word-9, #word-10, #word-11');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await page.getByRole('button', { name: /^(import|continue|next|confirm)$/i }).first().click();

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  await pwInputs.nth(0).fill(TEST_PASSWORD);
  await pwInputs.nth(1).fill(TEST_PASSWORD);
  await page.locator('label').filter({ hasText: /Terms.*Privacy Policy/i }).first().click();
  await page.getByRole('button', { name: /^(continue|create|finish|done)$/i }).first().click();
  await page.getByRole('button', { name: /^skip$/i }).click({ force: true });

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance');
  }, undefined, { timeout: 60_000, polling: 500 });
}

async function approveOylPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  try {
    const approval = await waitForApprovalPopup({
      context: ctx,
      knownPages,
      timeoutMs: 30_000,
      isApproval: async (p) => {
        if (!p.url().startsWith('chrome-extension://')) return false;
        await p.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        return true;
      },
    });
    await approval.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first().click();
  } catch { /* auto-resolved */ }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Oyl extension not unpacked at ${EXT_PATH}.`);
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
  onboardedDashboard = onboardPage;
});

test.afterAll(async () => {
  await context?.close();
});

for (const variant of VARIANTS) {
  test(`SDK returns the right address for Oyl ${variant.label}`, async () => {
    test.setTimeout(120_000);

    const harness = await context.newPage();
    await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
    await harness.waitForFunction(
      () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
      undefined,
      { timeout: 15_000 },
    );
    if (onboardedDashboard) await onboardedDashboard.bringToFront();

    const knownPages = new Set(context.pages());
    const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOyl());
    await approveOylPopup(context, knownPages);
    const info = await resultPromise;

    // eslint-disable-next-line no-console
    console.log(`[oyl-matrix:${variant.label}] address = ${info[variant.walletField]}`);
    expect(info[variant.walletField]).toBe(variant.expectedAddress);
  });
}
