import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';
import { onboardLeather } from '../onboard-leather';

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
  await onboardLeather(onboardPage, extensionId);
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

  // Leather's approval surface is identified by the stable testid
  // `get-addresses-approve-button` on whichever chrome-extension://
  // page renders it.
  let approval: Page;
  try {
    approval = await waitForApprovalPopup({
      context,
      knownPages,
      isApproval: async (p) => {
        if (!p.url().startsWith('chrome-extension://')) return false;
        await p.getByTestId('get-addresses-approve-button')
          .waitFor({ state: 'visible', timeout: 60_000 });
        return true;
      },
    });
  } catch {
    throw new Error('leather get-addresses approval popup never appeared');
  }
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
  // Compressed payment pubkey = 33 bytes = 66 hex.
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
  // Taproot pubkey is x-only (32 bytes = 64 hex) by SDK contract.
  // Leather v6.x returns it in compressed form (66 hex); the SDK's
  // parseLeatherAddressResponse normalises via toXOnlyPubkeyHex.
  expect(info.ordinalsPublicKey).toMatch(/^[0-9a-f]{64}$/);
});
