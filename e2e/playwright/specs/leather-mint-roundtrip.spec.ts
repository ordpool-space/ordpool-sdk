import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { waitForElectrsSync, waitForUtxoAt, waitForTxConfirmed, rpc, mineBlocks, postTx, assertAllInputsSighashAll, assertCatLandsAtRecipient } from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { onboardLeather } from '../onboard-leather';

/**
 * Full CAT-21 mint roundtrip with the real Leather extension.
 * Combines the wallet (Playwright + Leather) with the regtest stack
 * (bitcoind + electrs on localhost).
 *
 * Leather ignores its `network` arg in `getAddresses` and returns
 * mainnet `bc1q…` / `bc1p…` regardless of what the dapp requests. We
 * cross the network boundary via the two shims documented in the
 * workspace's `E2E_WALLET_TRICKS.md`:
 *
 *   1. `deriveRegtestAddresses(pubkey)` (in `sdk-harness.ts`) uses
 *      `@scure/btc-signer` to compute `bcrt1q` / `bcrt1p` from the
 *      same mainnet pubkey Leather returned. Fund the bcrt on regtest.
 *   2. `signerNetworkFor(leather)` returns `Network.Mainnet` (in
 *      `sdk-harness.ts:1028-1037`), so `signPsbt` is invoked with
 *      `network: 'mainnet'`. The signature verifies because the
 *      regtest input's scriptPubKey bytes are HRP-independent and
 *      match Leather's mainnet address hash byte-for-byte.
 *
 * Flow:
 *  1. Onboard Leather with the BIP-39 test seed.
 *  2. Open the harness; call connectLeather → mainnet bc1q / bc1p.
 *  3. Derive the regtest equivalents (deriveRegtestAddresses).
 *  4. Fund the bcrt1q via local bitcoind.
 *  5. Build CAT-21 PSBT; sign via LeatherProvider.request('signPsbt',
 *     {broadcast: false, network: 'mainnet'}); extract wire-format tx
 *     via the shared extractWireTxFromPsbt helper.
 *  6. Approve the sign popup (matched by role-name /^(confirm|sign|
 *     approve)$/i; Leather has no stable sign-testid).
 *  7. Broadcast via local electrs; mine; parse the result.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `leather-mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByTestId('get-addresses-approve-button')
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByTestId('get-addresses-approve-button').click();
}

async function approveSignPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  // Leather's sign-PSBT surface doesn't ship a stable testid yet;
  // match by the visible Confirm/Sign/Approve button's role + name.
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 90_000,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first()
        .waitFor({ state: 'visible', timeout: 90_000 });
      return true;
    },
  });
  await shot(approval, '03a-sign-approval');
  // Best-effort selector: text "Confirm" or a primary action button.
  // Will tighten once we see the actual sign-popup DOM in CI.
  const confirmBtn = approval.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first();
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
  await confirmBtn.click();
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

test('mint a cat21 on regtest via Leather: build PSBT in SDK, sign in popup (mainnet wallet, regtest PSBT), broadcast via local electrs', async () => {
  test.setTimeout(300_000);

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
  // eslint-disable-next-line no-console
  console.log(`[leather-mint] mainnet payment = ${wallet.paymentAddress}`);
  // BIP-84 m/84'/0'/0'/0/0 derivation of `abandon × 11 + about` on
  // mainnet — pinned because Leather is configured for regtest here
  // but its connector returns the mainnet payment address from the
  // same seed. Any drift in the bundled extension's derivation
  // (e.g. an internal upgrade that bumps the default account index)
  // surfaces here as a concrete diff rather than passing on /^bc1q/.
  expect(wallet.paymentAddress).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');

  // Same network-agnostic-keys trick we use for Unisat: derive
  // bcrt1q + bcrt1p from the same compressed pubkey.
  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  // eslint-disable-next-line no-console
  console.log(`[leather-mint] regtest payment = ${regtest.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[leather-mint] regtest ordinals = ${regtest.ordinalsAddress}`);
  expect(regtest.paymentAddress).toMatch(/^bcrt1q/);
  expect(regtest.ordinalsAddress).toMatch(/^bcrt1p/);

  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', regtest.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  // eslint-disable-next-line no-console
  console.log(`[leather-mint] funded ${regtest.paymentAddress} with ${FUND_AMOUNT_BTC} BTC in tx ${fundTxid}`);
  const newTip = mineBlocks(1);
  await waitForElectrsSync(newTip);

  const utxo = await waitForUtxoAt(regtest.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[leather-mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  const signKnownPages = new Set(context.pages());
  const signedHexPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'leather' as const,
      utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
      paymentAddress: regtest.paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: regtest.ordinalsAddress,
      feeSats: 1500,
    },
  );
  await approveSignPopup(context, signKnownPages);
  const signed = await signedHexPromise;
  // eslint-disable-next-line no-console
  console.log(`[leather-mint] signed tx hex (${signed.txHex.length} chars), broadcasting via local electrs…`);

  const broadcastTxid = await postTx(signed.txHex);
  // eslint-disable-next-line no-console
  console.log(`[leather-mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await waitForTxConfirmed(broadcastTxid);
  // eslint-disable-next-line no-console
  console.log(`[leather-mint] locktime=${esploraTx.locktime}  block_hash=${esploraTx.status.block_hash}`);
  expect(esploraTx.locktime).toBe(21);
  // The cat LANDED: vout[0] pays the recipient ordinals address at 546.
  assertCatLandsAtRecipient(esploraTx, regtest.ordinalsAddress);
  expect(esploraTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(esploraTx);

  // Cat-sat guard: every input's sequence MUST be >= 0xfffffffe (RBF-
  // final). A lower value would let a fee-bump replacement drop the
  // nLockTime=21 marker and kill the mint (no cat is produced) — the
  // 2024 Xverse-Accelerate mint-RBF incident this test suite exists
  // to prevent.
  for (const vin of esploraTx.vin) {
    expect(vin.sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
