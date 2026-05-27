import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 5 of the Unisat E2E pipeline: matrix spec across every
 * standard user-pickable address type Unisat exposes.
 *
 * Unisat lets the user pick one address type per wallet (Settings →
 * Address Type, or during onboard via the address-type-card screen
 * for the UniSat Wallet restore option). The wallet then returns
 * THAT address — and only that — via getAccounts. Our SDK
 * connector populates both paymentAddress and ordinalsAddress
 * from it.
 *
 * For the BIP-39 test seed `abandon × 11 + about` on mainnet, the
 * standard address-type derivations are well-known public test
 * vectors. We assert each one.
 *
 * The Unisat wallet config (from bundled ui.js v1.7.15):
 *   T0[0].addressTypes = [
 *     P2WPKH,        // index 0 — BIP-84 Native SegWit
 *     P2SH_P2WPKH,   // index 1 — BIP-49 Nested SegWit
 *     P2TR,          // index 2 — BIP-86 Taproot
 *     P2PKH,         // index 3 — BIP-44 Legacy
 *     M44_P2WPKH,    // index 4 — non-standard hybrid, skip
 *     M44_P2TR,      // index 5 — non-standard hybrid, skip
 *   ]
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

interface UnisatAddressTypeVariant {
  /** address-type-card-${addressTypeIndex} testid during onboard */
  addressTypeIndex: number;
  /** human label for test name + logging */
  label: string;
  /** expected derivation of `abandon × 11 + about` on mainnet at m/<bip>'/0'/0'/0/0 */
  expectedAddress: string;
}

// Public test vectors for `abandon × 11 + about` on mainnet.
const VARIANTS: ReadonlyArray<UnisatAddressTypeVariant> = [
  {
    addressTypeIndex: 0,
    label: 'P2WPKH (BIP-84 Native SegWit)',
    expectedAddress: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  },
  {
    addressTypeIndex: 1,
    label: 'P2SH_P2WPKH (BIP-49 Nested SegWit)',
    expectedAddress: '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf',
  },
  {
    addressTypeIndex: 2,
    label: 'P2TR (BIP-86 Taproot)',
    expectedAddress: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
  },
  {
    addressTypeIndex: 3,
    label: 'P2PKH (BIP-44 Legacy)',
    expectedAddress: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA',
  },
];

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `unisat-matrix-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardUnisatWithAddressType(
  context: BrowserContext,
  extensionId: string,
  addressTypeIndex: number,
): Promise<void> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('welcome-title')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('import-wallet-button').click();

  await expect(page.getByTestId('create-password-input')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-confirm-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-continue-button').click();

  await expect(page.getByTestId('restore-wallet-type-option-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('restore-wallet-type-option-0').click();

  await expect(page.getByTestId('mnemonic-import-word-0')).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await page.getByTestId(`mnemonic-import-word-${i}`).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await page.getByTestId('mnemonic-import-continue-button').click();

  // Address-type screen — the matrix-specific click.
  await expect(page.getByTestId(`address-type-card-${addressTypeIndex}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`address-type-card-${addressTypeIndex}`).click();
  await page.getByTestId('address-type-continue-button').click();

  // Post-restore notice popup (optional, version-dependent).
  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (await noticeCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await noticeCheckbox.click();
    const noticeOk = page.getByTestId('notice-ok-button');
    if (await noticeOk.isEnabled({ timeout: 3_000 }).catch(() => false)) {
      await noticeOk.click();
    }
  }

  await expect(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
  await page.close();
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  let approval: Page;
  try {
    approval = await waitForApprovalPopup({
      context: ctx,
      knownPages,
      isApproval: async (p) => {
        await p.waitForURL(/notification\.html#\/approval/, { timeout: 60_000 });
        return true;
      },
    });
  } catch {
    throw new Error('unisat connection-request popup never appeared');
  }
  await approval.getByText(/^Connect$/).first().click();
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Unisat extension not unpacked at ${EXT_PATH}.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }
});

for (const variant of VARIANTS) {
  test(`SDK returns the right address for Unisat ${variant.label}`, async () => {
    test.setTimeout(120_000);

    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    try {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
      const extensionId = worker.url().split('/')[2];

      await onboardUnisatWithAddressType(context, extensionId, variant.addressTypeIndex);
      await shot((await context.newPage()), `${variant.addressTypeIndex}-onboarded`);

      const harness = await context.newPage();
      await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
      await harness.waitForFunction(
        () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
        undefined,
        { timeout: 15_000 },
      );

      const knownPages = new Set(context.pages());
      const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());
      await approveConnectPopup(context, knownPages);
      const info = await resultPromise;

      // eslint-disable-next-line no-console
      console.log(`[unisat-matrix:${variant.addressTypeIndex}:${variant.label}] address = ${info.paymentAddress}`);
      expect(info.paymentAddress).toBe(variant.expectedAddress);
      // Unisat's single-address contract: ordinalsAddress mirrors paymentAddress.
      expect(info.ordinalsAddress).toBe(variant.expectedAddress);
    } finally {
      await context.close();
    }
  });
}
