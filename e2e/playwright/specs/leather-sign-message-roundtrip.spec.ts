/* eslint-disable no-console */
import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { onboardLeather } from '../onboard-leather';

/**
 * BIP-322 sign-message roundtrip with the real Leather extension. Promotes
 * Leather's `SignMessage` from `Adapter` to `Proven`: the real extension signs
 * a message under its Taproot ordinals key, and the SDK's
 * `verifyBip322Signature` validates it. Depends on the txid-byte-order fix in
 * `verify-bip322-signature.ts` (Leather signs via bitcoinjs-lib, internal-order
 * to_spend txid). No chain interaction.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const MESSAGE = 'ordpool sign-message e2e — prove BIP-322 roundtrip';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: path.resolve(RESULTS_DIR, `leather-sign-message-${name}.png`), fullPage: true }).catch(() => undefined);
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByTestId('get-addresses-approve-button').waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByTestId('get-addresses-approve-button').click();
}

async function approveSignMessagePopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 90_000,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first().waitFor({ state: 'visible', timeout: 90_000 });
      return true;
    },
  });
  await shot(approval, '02a-sign-message-approval');
  await approval.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first().click();
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) throw new Error(`Leather extension not unpacked at ${EXT_PATH}.`);
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--disable-dev-shm-usage'],
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

test('sign a BIP-322 message via Leather: real extension signs, SDK verifies', async () => {
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
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectLeather());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  console.log(`[leather-sign-message] ordinals address = ${wallet.ordinalsAddress}`);
  expect(wallet.ordinalsAddress).toMatch(/^bc1p/);

  const signKnownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.signMessage(args),
    { walletType: 'leather' as const, address: wallet.ordinalsAddress, message: MESSAGE },
  );
  await approveSignMessagePopup(context, signKnownPages);

  const result = await resultPromise;
  console.log(`[leather-sign-message] signature=${result.signature}`);
  console.log(`[leather-sign-message] verified=${result.verified} reason=${result.reason}`);

  expect(result.signature.length).toBeGreaterThan(0);
  expect(result.reason).toBeNull();
  expect(result.verified).toBe(true);
});
