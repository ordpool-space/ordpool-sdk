import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { waitForElectrsSync, waitForUtxoAt, waitForTxConfirmed, rpc, mineBlocks, postTx, assertAllInputsSighashAll } from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { approveCat21WalletConnectPopup, approveCat21WalletSignPopup } from '../cat21wallet-sign-popup';
import { onboardCat21Wallet } from '../onboard-cat21wallet';

/**
 * Iteration 4 — full cat21 mint roundtrip with the real Cat21 Wallet
 * extension. Combines Pipeline B's wallet (Playwright + Cat21 Wallet)
 * with the regtest stack (bitcoind + electrs on localhost).
 *
 * Cat21 Wallet supports a `regtest` network mode (both mainnet and
 * regtest use the `bcrt` HRP; `regtest` is the standard Bitcoin term
 * — the wallet also accepts Leather's legacy Stacks-era `devnet`
 * alias for backwards compatibility, but every new consumer should
 * use `regtest`). No cross-network trick needed — getAddresses
 * already returns the BIP-84 / BIP-86 mainnet derivations (we
 * hard-derive the regtest variants from the same pubkey via
 * @scure/btc-signer), and signPsbt accepts `network: 'regtest'`
 * directly (see `toLeatherNetworkString` in `src/network.ts`).
 *
 * Flow:
 *  1. Onboard Cat21 Wallet with the BIP-39 test seed.
 *  2. Open the harness; call connectCat21Wallet → mainnet bc1q / bc1p.
 *  3. Derive the regtest equivalents (deriveRegtestAddresses, same
 *     helper Unisat uses).
 *  4. Fund the bcrt1q via local bitcoind.
 *  5. Build CAT-21 PSBT; sign via Cat21Provider.request('signPsbt',
 *     {broadcast: false, network: 'regtest'}); extract wire-format
 *     tx via the shared extractWireTxFromPsbt helper.
 *  6. Approve the sign popup (testid: bitcoin-sign-psbt-confirm-button,
 *     discovered via the bundle's OnboardingSelectors).
 *  7. Broadcast via local electrs; mine; parse the result.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/cat21wallet');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `cat21wallet-mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

// onboardCat21Wallet now lives in ../onboard-cat21wallet (shared with the
// wallet-runner + the onboard spec — one onboard path, like onboard-okx.ts).

async function approveSignPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  await approveCat21WalletSignPopup({
    context: ctx,
    knownPages,
    screenshot: p => shot(p, '03a-sign-approval'),
  });
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

test('mint a cat21 on regtest via Cat21 Wallet: build PSBT in SDK, sign in popup, broadcast via local electrs', async () => {
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
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectCat21Wallet());
  await approveCat21WalletConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-mint] mainnet payment = ${wallet.paymentAddress}`);
  // BIP-84 m/84'/0'/0'/0/0 derivation of `abandon × 11 + about` on
  // mainnet — pinned because Cat21 Wallet is configured for devnet here
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
  console.log(`[cat21wallet-mint] regtest payment = ${regtest.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-mint] regtest ordinals = ${regtest.ordinalsAddress}`);
  expect(regtest.paymentAddress).toMatch(/^bcrt1q/);
  expect(regtest.ordinalsAddress).toMatch(/^bcrt1p/);

  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', regtest.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-mint] funded ${regtest.paymentAddress} with ${FUND_AMOUNT_BTC} BTC in tx ${fundTxid}`);
  const newTip = mineBlocks(1);
  await waitForElectrsSync(newTip);

  const utxo = await waitForUtxoAt(regtest.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  const signKnownPages = new Set(context.pages());
  const signedHexPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'cat21wallet' as const,
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
  console.log(`[cat21wallet-mint] signed tx hex (${signed.txHex.length} chars), broadcasting via local electrs…`);

  const broadcastTxid = await postTx(signed.txHex);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await waitForTxConfirmed(broadcastTxid);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-mint] locktime=${esploraTx.locktime}  block_hash=${esploraTx.status.block_hash}`);
  expect(esploraTx.locktime).toBe(21);
  expect(esploraTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(esploraTx);

  // RBF policy: cat21-wallet deliberately signals RBF (sequence
  // 0xfffffffd) because its mempool-acceleration UI guarantees that
  // any replacement preserves nLockTime=21. Any other value would
  // mean the signer regressed.
  for (const vin of esploraTx.vin) {
    expect(vin.sequence).toBe(0xfffffffd);
  }

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
