/* eslint-disable no-console */
import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { closeLeftoverExtensionPages } from '../approval-popup';
import { approveCat21WalletConnectPopup, approveCat21WalletSignPopup } from '../cat21wallet-sign-popup';
import { buildListingMessage } from '../../../src/cat21-listing/build-listing-message';
import { Network } from '../../../src/network';
import { onboardCat21Wallet } from '../onboard-cat21wallet';

/**
 * Full BIP-322 sign-message roundtrip with the real Cat21 Wallet extension.
 *
 * Proves the `SignMessage` capability end-to-end (promotes it from `Adapter`
 * to `Proven` in `WALLET_MATRIX`): the real extension signs a UTF-8 message
 * under the connected wallet's Taproot ordinals key, and the SDK's
 * `verifyBip322Signature` — the exact check `WalletService.signMessage` runs —
 * validates the returned signature against that address + message.
 *
 * No chain interaction: message signing never builds a PSBT or broadcasts, so
 * there is no funding / UTXO / mine step. The address the wallet signs under is
 * its mainnet-view ordinals address (bc1p) from connect — that is what the
 * signature must verify against, so no regtest address shim is used here.
 *
 * Flow:
 *  1. Onboard Cat21 Wallet with the BIP-39 test seed.
 *  2. Open the harness; connectCat21Wallet → mainnet bc1q / bc1p.
 *  3. `harness.signMessage({ address: ordinalsAddress, message })` → the
 *     extension opens its RpcSignBip322Message popup.
 *  4. Approve the message-sign popup (the generic Sign/Confirm/Approve match).
 *  5. Assert the returned signature is non-empty AND verifies (BIP-322).
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/cat21wallet');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const MESSAGE = 'ordpool sign-message e2e — prove BIP-322 roundtrip';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `cat21wallet-sign-message-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Cat21 Wallet extension not unpacked at ${EXT_PATH}.`);
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
  await onboardCat21Wallet(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('sign a BIP-322 message via Cat21 Wallet: real extension signs, SDK verifies', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectCat21Wallet());
  await approveCat21WalletConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  console.log(`[cat21wallet-sign-message] ordinals address = ${wallet.ordinalsAddress}`);
  expect(wallet.ordinalsAddress).toMatch(/^bc1p/);

  const signKnownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.signMessage(args),
    { walletType: 'cat21wallet' as const, address: wallet.ordinalsAddress, message: MESSAGE },
  );
  await approveCat21WalletSignPopup({
    context,
    knownPages: signKnownPages,
    screenshot: p => shot(p, '02a-sign-message-approval'),
  });

  const result = await resultPromise;
  console.log(`[cat21wallet-sign-message] signature=${result.signature}`);
  console.log(`[cat21wallet-sign-message] message=${JSON.stringify(MESSAGE)} verified=${result.verified} reason=${result.reason}`);

  expect(result.signature.length).toBeGreaterThan(0);
  expect(result.reason).toBeNull();
  expect(result.verified).toBe(true);

  // ── The REAL listing message: multi-line, exactly what the shipping
  // sell flow signs (build-listing-message.ts joins 10 fields with \n).
  // A wallet that normalizes newlines (CRLF conversion, trailing trim,
  // or a UI rejecting them) would produce unverifiable listing
  // signatures while the single-line roundtrip above stays green.
  const listingMessage = buildListingMessage({
    catNumber: 42,
    cats: [42],
    askSats: 21_000,
    payTo: wallet.paymentAddress,
    catTxid: 'ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df',
    catVout: 0,
    ordinalsAddress: wallet.ordinalsAddress,
    network: Network.Mainnet,
    signedAt: 1_756_944_000,
  });
  expect(listingMessage.split('\n').length).toBe(10);
  const listingKnownPages = new Set(context.pages());
  const listingPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.signMessage(args),
    { walletType: 'cat21wallet' as const, address: wallet.ordinalsAddress, message: listingMessage },
  );
  await approveCat21WalletSignPopup({
    context,
    knownPages: listingKnownPages,
    screenshot: p => shot(p, '03a-listing-sign-approval'),
  });
  const listingResult = await listingPromise;
  console.log(`[cat21wallet-sign-message] listing verified=${listingResult.verified} reason=${listingResult.reason}`);
  expect(listingResult.reason).toBeNull();
  expect(listingResult.verified).toBe(true);
});
