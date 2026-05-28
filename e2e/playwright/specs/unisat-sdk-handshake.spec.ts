import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 3 of the Unisat E2E pipeline: SDK ↔ Unisat handshake.
 *
 * - Onboard Unisat with the BIP-39 test seed via its UI
 *   (data-testid-driven, same flow as unisat-onboard.spec.ts)
 * - Open the SDK harness page (http://localhost:4500/) which
 *   imports the real `unisatConnector`
 * - Drive `window.ordpoolSdkHarness.connectUnisat()` via
 *   page.evaluate; this triggers `window.unisat.requestAccounts()`
 *   inside the Unisat content script
 * - Approve the resulting connection-request popup
 * - Assert that the returned paymentAddress is the BIP-84 native-
 *   segwit derivation of the test seed at m/84'/0'/0'/0/0
 *
 * Unisat uses a single address for both payments and ordinals
 * (per src/wallet/connectors/unisat.connector.ts comment) — so we
 * only assert one address. There is no separate BIP-86 ordinals
 * address for Unisat the way Xverse has.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

// BIP-84 native segwit derivation of TEST_MNEMONIC on mainnet:
//   m/84'/0'/0'/0/0
// This is what UniSat Wallet's default derivation (value=0 in the
// restore-wallet-type picker) produces. Same address Xverse returns
// for the same seed.
const EXPECTED_PAYMENT_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({
      path: path.resolve(RESULTS_DIR, `unisat-handshake-${name}.png`),
      fullPage: true,
    });
  } catch {
    // diagnostic, never fatal
  }
}

async function onboardUnisat(page: Page): Promise<void> {
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

  // Address-type picker MUST be advanced — without this the wallet
  // never reaches the dashboard and the connect handshake hangs.
  const addressTypeContinue = page.getByTestId('address-type-continue-button');
  await expect(addressTypeContinue).toBeVisible({ timeout: 15_000 });
  await addressTypeContinue.click();

  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (await noticeCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await noticeCheckbox.click();
    const noticeOk = page.getByTestId('notice-ok-button');
    if (await noticeOk.isEnabled({ timeout: 3_000 }).catch(() => false)) {
      await noticeOk.click();
    }
  }

  await expect(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Unisat extension not unpacked at ${EXT_PATH}.`);
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
  await onboardUnisat(onboardPage);
  await shot(onboardPage, '00-onboarded');
  // Keep the wallet popup open in the background — some wallets
  // refuse approval requests if no popup is currently the active
  // surface. Closing later in afterAll.
});

test.afterAll(async () => {
  await context?.close();
});

test('unisatConnector.connect via the harness page returns the BIP-84 mainnet address for the test seed', async () => {
  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // unisat.requestAccounts() triggers an approval popup on a new
  // chrome-extension:// page (sidepanel or popup). Listen for the
  // new page event, then click whatever Connect/Approve button it
  // renders.
  const knownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());

  // Unisat's connection-approval surface is `notification.html#/approval`
  // (confirmed in CI logs). URL-anchored event-driven wait — no polling
  // sleeps; predicate handles both the already-open and opens-later
  // races.
  let approval: Page;
  try {
    approval = await waitForApprovalPopup({
      context,
      knownPages,
      isApproval: async (p) => {
        await p.waitForURL(/notification\.html#\/approval/, { timeout: 60_000 });
        return true;
      },
    });
  } catch {
    await shot(harness, '02a-no-approval');
    throw new Error('unisat connection-request popup never appeared');
  }
  await shot(approval, '02a-approval-rendered');
  // eslint-disable-next-line no-console
  console.log(`[unisat:sdk-handshake] approval URL = ${approval.url()}`);

  // Unisat's connect-approval renders "Connect" as a styled <div>
  // (with a clickable wrapper), not a <button>, so getByRole('button')
  // doesn't see it. Match by exact text instead.
  const consentBtn = approval.getByText(/^Connect$/).first();
  await expect(consentBtn).toBeVisible({ timeout: 10_000 });
  await consentBtn.click();
  await shot(approval, '02b-after-approve');

  const info = await resultPromise;
  // eslint-disable-next-line no-console
  console.log(`[unisat:sdk-handshake] paymentAddress = ${info.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[unisat:sdk-handshake] paymentPublicKey = ${info.paymentPublicKey}`);
  await shot(harness, '03-after-connect');

  expect(info.signingSupported).toBe(true);
  expect(info.paymentAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  // Unisat reuses one address for both lanes — assert equality
  // rather than two distinct derivations.
  expect(info.ordinalsAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  // Compressed pubkey = 33 bytes = 66 hex chars.
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
});
