/* eslint-disable no-console */
import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { buildListingMessage } from '../../../src/cat21-listing/build-listing-message';
import { Network } from '../../../src/network';
import { onboardUnisat } from '../onboard-unisat';

/**
 * BIP-322 sign-message roundtrip with the real Unisat extension. Promotes
 * Unisat's `SignMessage` from `Adapter` to `Proven`.
 *
 * Unisat signs under its ACTIVE address (`window.unisat.signMessage(msg,
 * 'bip322-simple')` takes no address parameter), and `verifyBip322Signature`
 * decodes P2TR only (CAT-21 signs under the taproot ordinals key). So the
 * wallet is onboarded in BIP-86 Taproot mode (`addressTypeIndex: 2`): the
 * active address IS the taproot key, its signature is a taproot BIP-322
 * witness, and the verifier can check it. A native-segwit account would
 * produce a p2wpkh BIP-322 signature the verifier rejects by design.
 * Depends on the txid-byte-order fix in `verify-bip322-signature.ts`.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const MESSAGE = 'ordpool sign-message e2e — prove BIP-322 roundtrip';

// BIP-86 Taproot derivation of `abandon × 11 + about` on mainnet — the same
// vector unisat-matrix.spec.ts pins for addressTypeIndex 2.
const UNISAT_MAINNET_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: path.resolve(RESULTS_DIR, `unisat-sign-message-${name}.png`), fullPage: true }).catch(() => undefined);
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => { await p.waitForURL(/notification\.html#\/approval/, { timeout: 60_000 }); return true; },
  });
  await approval.getByText(/^Connect$/).first().click();
}

async function approveSignMessagePopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 90_000,
    isApproval: async (p) => { await p.waitForURL(/notification\.html#\/approval/, { timeout: 90_000 }); return true; },
  });
  await shot(approval, '02a-sign-message-approval');
  // Unisat renders actions as styled divs, not <button>. Match by text.
  await approval.getByText(/^(Sign|Confirm|Approve)$/).first().click();
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) throw new Error(`Unisat extension not unpacked at ${EXT_PATH}.`);
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  const onboardPage = await context.newPage();
  // addressTypeIndex 2 = P2TR (BIP-86 Taproot) — see the doc comment above.
  await onboardUnisat(onboardPage, extensionId, { addressTypeIndex: 2 });
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('sign a BIP-322 message via Unisat (Taproot mode): real extension signs, SDK verifies', async () => {
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
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  console.log(`[unisat-sign-message] ordinals address = ${wallet.ordinalsAddress}`);
  // Taproot mode: the active (= ordinals) address is the pinned BIP-86 vector.
  expect(wallet.ordinalsAddress).toBe(UNISAT_MAINNET_TAPROOT);

  const signKnownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.signMessage(args),
    { walletType: 'unisat' as const, address: wallet.ordinalsAddress, message: MESSAGE },
  );
  await approveSignMessagePopup(context, signKnownPages);

  const result = await resultPromise;
  console.log(`[unisat-sign-message] signature=${result.signature}`);
  console.log(`[unisat-sign-message] verified=${result.verified} reason=${result.reason}`);

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
    { walletType: 'unisat' as const, address: wallet.ordinalsAddress, message: listingMessage },
  );
  await approveSignMessagePopup(context, listingKnownPages);
  const listingResult = await listingPromise;
  console.log(`[unisat-sign-message] listing verified=${listingResult.verified} reason=${listingResult.reason}`);
  expect(listingResult.reason).toBeNull();
  expect(listingResult.verified).toBe(true);
});
