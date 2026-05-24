import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 3 of the Leather E2E pipeline: SDK ↔ Leather handshake.
 *
 * - Onboard Leather with the BIP-39 test seed via its UI
 *   (testid-driven, same flow as leather-onboard.spec.ts)
 * - Open the SDK harness page (http://localhost:4500/) which
 *   imports the real `leatherConnector`
 * - Drive `window.ordpoolSdkHarness.connectLeather()` — this
 *   calls `LeatherProvider.request('getAddresses')` inside the
 *   content script
 * - Approve the connection-request popup via its
 *   `get-addresses-approve-button` testid
 * - Assert the returned paymentAddress = BIP-84 derivation,
 *   ordinalsAddress = BIP-86 derivation for the test seed
 *
 * Leather is the model wallet for the "WE finalize, WE broadcast"
 * convention — its signer already returns the signed PSBT for the
 * SDK to extract + broadcast.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';

// Expected derivations for `abandon × 11 + about` on mainnet:
//   m/84'/0'/0'/0/0  BIP-84 P2WPKH  Native SegWit  = paymentAddress
//   m/86'/0'/0'/0/0  BIP-86 P2TR    Taproot        = ordinalsAddress
const EXPECTED_PAYMENT_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const EXPECTED_ORDINALS_ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `leather-handshake-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardLeather(page: Page): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('sign-in-link')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sign-in-link').click();

  // Fill the first 12 mnemonic boxes (per-word). Boxes are
  // input[type=password] for masking; first one becomes visible
  // when the restore screen renders.
  const inputs = page.locator('input[type="text"], input[type="password"]');
  await expect(inputs.first()).toBeVisible({ timeout: 15_000 });
  const words = TEST_MNEMONIC.split(' ');
  for (let i = 0; i < 12; i++) {
    await inputs.nth(i).fill(words[i]);
  }
  await page.getByRole('button', { name: /continue|sign in|restore|confirm/i }).first().click();

  // Password screen: testid-driven.
  const pwInput = page.getByTestId('set-or-enter-password-input');
  await expect(pwInput).toBeVisible({ timeout: 15_000 });
  await pwInput.click();
  await pwInput.pressSequentially(TEST_PASSWORD, { delay: 15 });
  await page.getByTestId('set-password-btn').click();

  // Wait for dashboard.
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('bitcoin');
  }, undefined, { timeout: 30_000, polling: 250 });
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Leather extension not unpacked at ${EXT_PATH}.`);
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
  await onboardLeather(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('leatherConnector.connect via the harness page returns the BIP-84 / BIP-86 mainnet addresses for the test seed', async () => {
  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // LeatherProvider.request('getAddresses') opens a connection-
  // request popup on a new chrome-extension:// page. Listen for it,
  // then click `get-addresses-approve-button` (the OnboardingSelectors
  // enum exposes this testid in the bundle).
  const knownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectLeather());

  const deadline = Date.now() + 60_000;
  let approval: Page | undefined;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (knownPages.has(p)) continue;
      if (!p.url().startsWith('chrome-extension://')) continue;
      if (await p.getByTestId('get-addresses-approve-button').isVisible({ timeout: 200 }).catch(() => false)) {
        approval = p;
        break;
      }
    }
    if (approval) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!approval) throw new Error('leather get-addresses approval popup never appeared');
  await shot(approval, '02a-approval');
  await approval.getByTestId('get-addresses-approve-button').click();
  await shot(approval, '02b-after-approve');

  const info = await resultPromise;
  // eslint-disable-next-line no-console
  console.log(`[leather:sdk-handshake] payment  = ${info.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[leather:sdk-handshake] ordinals = ${info.ordinalsAddress}`);
  await shot(harness, '03-after-connect');

  expect(info.signingSupported).toBe(true);
  expect(info.paymentAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  expect(info.ordinalsAddress).toBe(EXPECTED_ORDINALS_ADDRESS);
  // Compressed payment pubkey = 33 bytes = 66 hex; taproot x-only = 32 bytes = 64 hex.
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
  expect(info.ordinalsPublicKey).toMatch(/^[0-9a-f]{64}$/);
});
