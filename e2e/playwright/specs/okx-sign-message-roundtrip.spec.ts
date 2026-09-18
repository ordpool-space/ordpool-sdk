/* eslint-disable no-console */
import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  clickApprovalAndRequireClose,
  waitForApprovalByConfirmButton,
  waitForApprovalPopup,
  closeLeftoverExtensionPages,
} from '../approval-popup';
import { isVisibleWithin } from '../is-visible-within';
import { buildListingMessage } from '../../../src/cat21-listing/build-listing-message';
import { Network } from '../../../src/network';
import { onboardOkx } from '../onboard-okx';

/**
 * BIP-322 sign-message roundtrip with the real OKX extension. Promotes OKX's
 * `SignMessage` from `Adapter` to `Proven`: `window.okxwallet.bitcoin.signMessage
 * (message, { from, protocol: 'bip322-simple' })` signs under the ordinals
 * address, and the SDK's `verifyBip322Signature` validates it. Depends on the
 * txid-byte-order fix in `verify-bip322-signature.ts`.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const MESSAGE = 'ordpool sign-message e2e — prove BIP-322 roundtrip';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: path.resolve(RESULTS_DIR, `okx-sign-message-${name}.png`), fullPage: true }).catch(() => undefined);
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByText('Connect account').first().waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByRole('button', { name: /^connect$/i }).first().click();
}

/**
 * OKX reuses the connect popup's page for signing and renames the heading
 * across releases, so poll every extension page for a signature-request
 * heading rather than relying on knownPages. Then dismiss the optional
 * "Asset transfer pending" promo modal and click Confirm.
 */
async function approveSignMessagePopup(ctx: BrowserContext, label: string): Promise<void> {
  // Wait for the CONFIRM BUTTON, not for heading text.
  //
  // The previous version polled every extension page's body text every 500ms
  // against a list of headings, for two minutes. That made the result depend on
  // machine speed (the same spec passes in 5.4s on an idle runner and timed out
  // at 120s on a loaded one) and on OKX's copy, which it renames across
  // releases. Both are properties of the test rather than of the wallet.
  //
  // The button is what the next line actually needs, so waiting for it removes
  // the gap between "a heading appeared" and "something is clickable", and
  // Playwright's own waiting is event-driven rather than a busy-wait.
  //
  // An EMPTY knownPages is deliberate: OKX serves signing from the same
  // notification page it used for connect, so a set carrying that page would
  // make the helper skip the very page the popup lives on.
  const approval = await waitForApprovalByConfirmButton({
    context: ctx,
    label: `OKX ${label} signing popup`,
  });

  await shot(approval, `02a-sign-message-approval-${label}`);

  const promo = approval.getByText('Asset transfer pending');
  if (await isVisibleWithin(promo, 2_000)) {
    const closeBtn = approval.locator('button:has(svg), [aria-label="close" i], [aria-label="Close" i]').first();
    await closeBtn.click({ force: true }).catch(() => undefined);
    await promo.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }
  // OKX closes this popup on accepting the click, so the close IS the proof the
  // click landed. Requiring it names the outcome here instead of letting a lost
  // click surface later as a harness wait that times out with several suspects.
  await clickApprovalAndRequireClose(
    approval.getByText(/^(Confirm|Sign|Approve)$/, { exact: true }).first(),
    approval,
    { clickTimeoutMs: 45_000, closeTimeoutMs: 30_000, label: `OKX ${label} signing popup` },
  );
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) throw new Error(`OKX extension not unpacked at ${EXT_PATH}. This is a missing prerequisite, not a test failure: run e2e/playwright/playwright-bootstrap.sh okx.`);
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // OKX absorbs the welcome-screen click unless navigator.webdriver is hidden.
      '--disable-blink-features=AutomationControlled',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  // OKX auto-opens its own onboarding tab on install; reuse it. Creating a
  // fresh page and navigating it collides with OKX's auto-navigation and
  // closes the context (all-attempts onboarding failure). Fall back to a new
  // page only if the auto-opened tab never appears.
  let onboardPage: Page | undefined;
  try {
    onboardPage = await context.waitForEvent('page', {
      predicate: p => p.url().startsWith(`chrome-extension://${extensionId}`),
      timeout: 15_000,
    });
  } catch {
    /* fall back below */
  }
  test.setTimeout(240_000);
  if (!onboardPage) onboardPage = await context.newPage();
  await onboardOkx(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('sign a BIP-322 message via OKX: real extension signs, SDK verifies', async () => {
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
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOkx());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  console.log(`[okx-sign-message] ordinals address = ${wallet.ordinalsAddress}`);
  expect(wallet.ordinalsAddress).toMatch(/^bc1p/);

  const resultPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.signMessage(args),
    { walletType: 'okx' as const, address: wallet.ordinalsAddress, message: MESSAGE },
  );
  await approveSignMessagePopup(context, 'single-line');

  const result = await resultPromise;
  console.log(`[okx-sign-message] signature=${result.signature}`);
  console.log(`[okx-sign-message] verified=${result.verified} reason=${result.reason}`);

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
  const listingPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.signMessage(args),
    { walletType: 'okx' as const, address: wallet.ordinalsAddress, message: listingMessage },
  );
  await approveSignMessagePopup(context, 'listing-message');
  const listingResult = await listingPromise;
  console.log(`[okx-sign-message] listing verified=${listingResult.verified} reason=${listingResult.reason}`);
  expect(listingResult.reason).toBeNull();
  expect(listingResult.verified).toBe(true);
});
