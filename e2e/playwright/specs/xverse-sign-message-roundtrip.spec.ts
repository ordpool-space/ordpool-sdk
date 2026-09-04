/* eslint-disable no-console */
import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { buildListingMessage } from '../../../src/cat21-listing/build-listing-message';
import { Network } from '../../../src/network';
import { onboardXverse } from '../onboard-xverse';

/**
 * BIP-322 sign-message roundtrip with the real Xverse extension. Promotes
 * Xverse's `SignMessage` from `Adapter` to `Proven`: the real extension signs
 * a message under its Taproot ordinals key via sats-connect
 * `Wallet.request('signMessage', { address, message, protocol: BIP322 })`, and
 * the SDK's `verifyBip322Signature` validates it.
 *
 * This spec onboards Xverse FRESH on MAINNET (not the regtest seed the mint /
 * transfer specs reuse). `verifyBip322Signature` decodes mainnet (`bc`) and
 * testnet3 (`tb`) HRPs only; a regtest `bcrt1p` address falls through as
 * unsupported, so a message signed under a regtest ordinals key could never
 * verify. Sign-message is pure crypto with no chain interaction, so mainnet is
 * the right context here. Depends on the txid-byte-order fix in
 * `verify-bip322-signature.ts`.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const MESSAGE = 'ordpool sign-message e2e — prove BIP-322 roundtrip';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: path.resolve(RESULTS_DIR, `xverse-sign-message-${name}.png`), fullPage: true }).catch(() => undefined);
}

/**
 * Xverse's sign-message popup renders the message plus a Sign / Confirm button.
 * Wait for that button to be present and enabled (Xverse hooks its React
 * onClick after an async detail-resolve, same as the sign-transaction popup),
 * then click it.
 */
async function approveSignMessagePopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 120_000,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByRole('button', { name: /^(sign message|sign|confirm|approve)$/i }).first()
        .waitFor({ state: 'visible', timeout: 120_000 });
      return true;
    },
  });
  await shot(approval, '02a-sign-message-approval');
  await approval.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(b => {
      if (!/^(sign message|sign|confirm|approve)$/i.test(b.textContent?.trim() ?? '')) return false;
      if (b.hasAttribute('disabled')) return false;
      const style = getComputedStyle(b);
      return style.pointerEvents !== 'none' && style.visibility !== 'hidden';
    });
  }, undefined, { timeout: 30_000, polling: 250 });
  await approval.getByRole('button', { name: /^(sign message|sign|confirm|approve)$/i }).first()
    .click({ force: true });
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) throw new Error(`Xverse extension not unpacked at ${EXT_PATH}.`);
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');

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

  // Fresh mainnet onboarding (no primeAndSwitchToRegtest): leaves Xverse on
  // Bitcoin mainnet + unlocked on the dashboard.
  await onboardXverse(context, extensionId);
});

test.afterAll(async () => {
  await context?.close();
});

test('sign a BIP-322 message via Xverse: real extension signs, SDK verifies', async () => {
  test.setTimeout(240_000);

  // Dismiss any post-onboard promo ("Not now") so it can't overlay the popups.
  const primer = await context.newPage();
  await primer.setViewportSize({ width: 400, height: 800 });
  await primer.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const notNow = primer.getByText('Not now', { exact: true }).first();
  if (await notNow.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await notNow.click({ force: true }).catch(() => undefined);
  }
  await shot(primer, '00-dashboard-ready');

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // Connect on MAINNET so the ordinals address is a bc1p taproot address the
  // verifier supports.
  const connectPagePromise = context.waitForEvent('page', { timeout: 60_000 });
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectXverse('mainnet'));
  const approvalConnect = await connectPagePromise;
  await approvalConnect.waitForLoadState('domcontentloaded');
  await approvalConnect.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return ['connect', 'approve', 'confirm', 'allow'].some(s => t.includes(s));
  }, undefined, { timeout: 60_000, polling: 500 });
  await approvalConnect.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first().click();
  const wallet = await connectResultPromise;
  // Close the connect popup so Xverse opens a fresh tab for the sign step
  // (context.on('page') reliably catches a new tab, not a reused one).
  await approvalConnect.close().catch(() => undefined);
  console.log(`[xverse-sign-message] ordinals address = ${wallet.ordinalsAddress}`);
  expect(wallet.ordinalsAddress).toMatch(/^bc1p/);

  const signKnownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.signMessage(args),
    { walletType: 'xverse' as const, address: wallet.ordinalsAddress, message: MESSAGE },
  );
  await approveSignMessagePopup(context, signKnownPages);
  await closeLeftoverExtensionPages(context, signKnownPages);

  const result = await resultPromise;
  console.log(`[xverse-sign-message] signature=${result.signature}`);
  console.log(`[xverse-sign-message] verified=${result.verified} reason=${result.reason}`);

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
    { walletType: 'xverse' as const, address: wallet.ordinalsAddress, message: listingMessage },
  );
  await approveSignMessagePopup(context, listingKnownPages);
  const listingResult = await listingPromise;
  console.log(`[xverse-sign-message] listing verified=${listingResult.verified} reason=${listingResult.reason}`);
  expect(listingResult.reason).toBeNull();
  expect(listingResult.verified).toBe(true);
});
