import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';
import { onboardOkx } from '../onboard-okx';

/**
 * Iteration 4 of the OKX E2E pipeline: matrix spec.
 *
 * OKX exposes a single Bitcoin sub-provider (`window.okxwallet.bitcoin`)
 * whose `getAccounts()` returns whichever address type is ACTIVE in
 * Settings → Wallet → Bitcoin Address Type. Unlike Unisat/Wizz which
 * surface address-type selection during onboarding, OKX commits to
 * BIP-86 Taproot as the default after a fresh restore and only
 * changes the active type via deep UI navigation:
 *
 *   Dashboard → Settings → Wallet → Manage wallets → <wallet>
 *     → Bitcoin Address Type → Native SegWit | Nested SegWit |
 *       Taproot | Legacy
 *
 * That UI dance is fragile to automate cleanly (multiple navigation
 * steps, version-sensitive testids, modal confirmations). For the
 * matrix we assert only the DEFAULT (BIP-86 Taproot) variant — same
 * single derivation pinned in okx-sdk-handshake but bundled here as
 * the matrix entry point. The non-default variants are left as a
 * follow-up: switching active types programmatically via chrome.storage
 * mutation (OKX persists the active typeIndex per wallet under
 * `_state_keychain`) is the cleanest path, pending source-code review
 * of the storage key schema.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

interface OkxAddressVariant {
  label: string;
  expectedAddress: string;
}

const VARIANTS: ReadonlyArray<OkxAddressVariant> = [
  {
    label: 'P2TR (BIP-86 Taproot) — default',
    expectedAddress: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
  },
];

let context: BrowserContext;
let extensionId: string;
let onboardPage: Page | null = null;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `okx-matrix-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function approveOkxPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first()
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first().click();
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
      '--disable-blink-features=AutomationControlled',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  try {
    onboardPage = await context.waitForEvent('page', {
      predicate: p => p.url().startsWith(`chrome-extension://${extensionId}`),
      timeout: 15_000,
    });
  } catch { /* fall through */ }
  test.setTimeout(240_000);
  if (!onboardPage) onboardPage = await context.newPage();
  await onboardOkx(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

for (const variant of VARIANTS) {
  test(`SDK returns the right address for OKX ${variant.label}`, async () => {
    test.setTimeout(120_000);

    const harness = await context.newPage();
    await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
    await harness.waitForFunction(
      () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
      undefined,
      { timeout: 15_000 },
    );

    const knownPages = new Set(context.pages());
    const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOkx());
    await approveOkxPopup(context, knownPages);
    const info = await resultPromise;

    // eslint-disable-next-line no-console
    console.log(`[okx-matrix:${variant.label}] address = ${info.paymentAddress}`);
    expect(info.paymentAddress).toBe(variant.expectedAddress);
    // Single-address contract: ordinalsAddress mirrors paymentAddress.
    expect(info.ordinalsAddress).toBe(variant.expectedAddress);
  });
}
