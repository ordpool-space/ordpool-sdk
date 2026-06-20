import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { waitForElectrsSync, waitForUtxoAt, waitForTxConfirmed, rpc, mineBlocks, postTx, assertAllInputsSighashAll } from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';

/**
 * Iteration 5 — full cat21 mint roundtrip with the real Oyl
 * extension. Oyl exposes BOTH nativeSegwit + taproot per connect
 * (dual-address contract, like Xverse and Phantom). The payment
 * lane is BIP-84 P2WPKH; we mint with that as the input and the
 * BIP-86 P2TR address as the recipient.
 *
 * Cross-network-keys trick — Oyl's signPsbt accepts a base64 PSBT
 * + inputsToSign array. We onboard on Oyl's default (mainnet),
 * fund the regtest bcrt1q derived from the same compressed pubkey,
 * and let Oyl sign — the script hash is HRP-independent so Oyl's
 * inputsToSign match succeeds on its mainnet address while the
 * PSBT itself encodes regtest semantics. We broadcast via local
 * electrs.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/oyl');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;
let onboardedDashboard: Page | null = null;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `oyl-mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardOyl(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/tabs/index.html`, { waitUntil: 'domcontentloaded' });

  const importBtn = page.getByText('Import wallet', { exact: true });
  await expect(importBtn).toBeVisible({ timeout: 30_000 });
  await importBtn.click();

  const mnemonicInputs = page.locator('#word-0, #word-1, #word-2, #word-3, #word-4, #word-5, #word-6, #word-7, #word-8, #word-9, #word-10, #word-11');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await page.getByRole('button', { name: /^(import|continue|next|confirm)$/i }).first().click();

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  await pwInputs.nth(0).fill(TEST_PASSWORD);
  await pwInputs.nth(1).fill(TEST_PASSWORD);
  const termsLabel = page.locator('label').filter({ hasText: /Terms.*Privacy Policy/i }).first();
  await termsLabel.click();
  const pwContinue = page.getByRole('button', { name: /^(continue|create|finish|done)$/i }).first();
  // Intermittent flake: terms label click sometimes doesn't
  // propagate. Re-click + direct checkbox dispatch fallback.
  try {
    await expect(pwContinue).toBeEnabled({ timeout: 10_000 });
  } catch {
    await termsLabel.click({ force: true }).catch(() => undefined);
    await page.evaluate(() => {
      const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (cb && !cb.checked) {
        cb.click();
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await expect(pwContinue).toBeEnabled({ timeout: 20_000 });
  }
  await pwContinue.click();

  await page.getByRole('button', { name: /^skip$/i }).click({ force: true });

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance');
  }, undefined, { timeout: 60_000, polling: 500 });
}

async function approveOylPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  // Oyl's approval may not pop up (auto-resolves from current account)
  // or it may render a confirm/approve button. Race both paths.
  try {
    const approval = await waitForApprovalPopup({
      context: ctx,
      knownPages,
      timeoutMs: 30_000,
      isApproval: async (p) => {
        if (!p.url().startsWith('chrome-extension://')) return false;
        await p.getByRole('button', { name: /^(connect|approve|confirm|allow|sign)$/i }).first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        return true;
      },
    });
    await shot(approval, '03a-approval');
    await approval.getByRole('button', { name: /^(connect|approve|confirm|allow|sign)$/i }).first().click();
  } catch {
    // Auto-resolved; nothing to click.
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Oyl extension not unpacked at ${EXT_PATH}.`);
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
  test.setTimeout(240_000);
  await onboardOyl(onboardPage);
  await shot(onboardPage, '00-onboarded');
  onboardedDashboard = onboardPage;
});

test.afterAll(async () => {
  await context?.close();
});

// Reactivated after source-diving the v1.17.1 binary: the relay
// validator at static/background/index.js byte 4708500 expects
// `body.psbt` (hex string) — the "A psbt hex is required" error
// message refers to the value's type, not the parameter name.
// Both `psbtBase64` and `psbtHex` parameters were ignored. Fixed
// in the harness to pass `{ psbt: psbtHex, ... }`.
test('mint a cat21 on regtest via Oyl: build PSBT in SDK, sign in popup (mainnet wallet, regtest PSBT), broadcast via local electrs', async () => {
  test.setTimeout(300_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  if (onboardedDashboard) await onboardedDashboard.bringToFront();

  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOyl());
  await approveOylPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  console.log(`[oyl-mint] mainnet payment = ${wallet.paymentAddress}`);
  console.log(`[oyl-mint] mainnet ordinals = ${wallet.ordinalsAddress}`);
  expect(wallet.paymentAddress).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  expect(wallet.ordinalsAddress).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');

  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  console.log(`[oyl-mint] regtest payment = ${regtest.paymentAddress}`);
  console.log(`[oyl-mint] regtest ordinals = ${regtest.ordinalsAddress}`);

  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', regtest.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  console.log(`[oyl-mint] funded ${regtest.paymentAddress} with ${FUND_AMOUNT_BTC} BTC in tx ${fundTxid}`);
  const newTip = mineBlocks(1);
  await waitForElectrsSync(newTip);

  const utxo = await waitForUtxoAt(regtest.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  console.log(`[oyl-mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  if (onboardedDashboard) await onboardedDashboard.bringToFront();
  const signKnownPages = new Set(context.pages());
  const signedHexPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'oyl' as const,
      utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
      paymentAddress: regtest.paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: regtest.ordinalsAddress,
      feeSats: 1500,
    },
  );
  await approveOylPopup(context, signKnownPages);
  const signed = await signedHexPromise;
  console.log(`[oyl-mint] signed tx hex (${signed.txHex.length} chars), broadcasting via local electrs…`);

  const broadcastTxid = await postTx(signed.txHex);
  console.log(`[oyl-mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await waitForTxConfirmed(broadcastTxid);
  console.log(`[oyl-mint] locktime=${esploraTx.locktime}  block_hash=${esploraTx.status.block_hash}`);
  expect(esploraTx.locktime).toBe(21);
  assertAllInputsSighashAll(esploraTx);

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
