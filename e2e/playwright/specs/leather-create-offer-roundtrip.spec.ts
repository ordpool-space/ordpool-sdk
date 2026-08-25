import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { Network, toScureNetwork } from '../../../src/network';
import {
  waitForElectrsSync,
  waitForUtxoAt,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
  assertAllInputsSighashAll,
  getUtxos,
} from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { buildCat21MintPsbt } from '../../../src/cat21-mint/cat21-mint.helper';
import { validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * Leather CREATE-OFFER roundtrip on regtest — Leather is the BUYER.
 * Proves the real Leather binary signs the buyer side of a CAT-21
 * buy-offer end-to-end. Turns the SDK matrix's `leather / createOffer`
 * adapter cell into `proven`.
 *
 * The Leather CI shard runs ONLY bitcoind + electrs (no cat21-ord), so
 * ownership is asserted against electrs + the parser, never ord.
 *
 * Flow:
 *  1. Onboard Leather, connect on mainnet, derive regtest addresses
 *     inline (buyer payment bcrt1q, buyer-receive ordinals bcrt1p).
 *  2. Fund the Leather (buyer) payment address via bitcoind.
 *  3. Synthesise a SELLER raw P2WPKH keypair; fund it; pure-SDK mint a
 *     cat at the seller's own address (raw key signs input 0). The cat
 *     lives on the seller's bcrt1q UTXO.
 *  4. Leather builds a buy-offer PSBT against the seller's cat with the
 *     wallet's funding UTXO at input 1, and signs ONLY input 1 via
 *     signOfferCreatePsbt (1 popup). Input 0 (the seller's cat) stays
 *     UNSIGNED per the buyer-initiated PSBT contract.
 *  5. Seller (raw key) signs input 0 SIGHASH_ALL, finalizes, broadcasts.
 *  6. Assert via electrs: the cat's 546-sat output-0 UTXO lands at
 *     Leather's buyer-receive (ordinals) address, the seller is paid
 *     priceSats + postage, lockTime=21, SIGHASH_ALL on every input, and
 *     the acceptance tx parses as a CAT-21.
 *
 * Network: same mainnet-keys shim as leather-transfer/leather-mint —
 * Leather signs its funding input (BIP-84, network-invariant) with its
 * mainnet key; the signature verifies against the regtest PSBT.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';

const FUND_AMOUNT_BTC = 0.001;
const SELLER_FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const OFFER_FEE_SATS = 1500;
const PRICE_SATS = 50_000;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `leather-create-offer-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

function hexBytes(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

async function onboardLeather(page: Page): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-in-link')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sign-in-link').click();

  const inputs = page.locator('input[type="text"], input[type="password"]');
  await expect(inputs.first()).toBeVisible({ timeout: 15_000 });
  const words = TEST_MNEMONIC.split(' ');
  for (let i = 0; i < 12; i++) {
    await inputs.nth(i).fill(words[i]);
  }
  await page.getByRole('button', { name: /continue|sign in|restore|confirm/i }).first().click();

  const pwInput = page.getByTestId('set-or-enter-password-input');
  await expect(pwInput).toBeVisible({ timeout: 15_000 });
  await pwInput.click();
  await pwInput.pressSequentially(TEST_PASSWORD, { delay: 15 });
  await page.getByTestId('set-password-btn').click();

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('bitcoin');
  }, undefined, { timeout: 30_000, polling: 250 });
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

/**
 * Wait for a Leather sign popup, approve it, and register it in
 * `knownPages`. The createOffer flow fires a single popup — Leather
 * signs only its funding input (index 1). Leather's sign surface has no
 * stable testid; match by the Confirm/Sign/Approve button's role+name.
 */
async function approveSignPopup(ctx: BrowserContext, knownPages: Set<Page>, tag: string): Promise<void> {
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
  await shot(approval, tag);
  const confirmBtn = approval.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first();
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
  await confirmBtn.click();
  knownPages.add(approval);
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

test('build + sign a CAT-21 buy-offer on regtest via Leather (buyer): seller raw-key mints, Leather signs buyer input 1, seller signs input 0', async () => {
  test.setTimeout(600_000);
  const regtestNetwork = toScureNetwork(Network.Regtest);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // ── Connect on mainnet; derive regtest equivalents inline ──
  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectLeather());
  await approveConnectPopup(context, connectKnownPages);
  const walletMainnet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);

  const paymentAddress = btc.p2wpkh(hexBytes(walletMainnet.paymentPublicKey), regtestNetwork).address!;
  const ordinalsXOnlyHex = walletMainnet.ordinalsPublicKey.length === 66
    ? walletMainnet.ordinalsPublicKey.slice(2)
    : walletMainnet.ordinalsPublicKey;
  const ordinalsAddress = btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).address!;
  expect(paymentAddress).toMatch(/^bcrt1q/);
  expect(ordinalsAddress).toMatch(/^bcrt1p/);
  // eslint-disable-next-line no-console
  console.log(`[leather-create-offer] buyer payment=${paymentAddress} buyer-receive=${ordinalsAddress}`);

  // ── Fund the Leather (buyer) payment address ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', paymentAddress, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const walletFundUtxo = await waitForUtxoAt(paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[leather-create-offer] buyer funded utxo ${walletFundUtxo.txid}:${walletFundUtxo.vout} (${walletFundUtxo.value} sats)`);

  // ── Synthesise the seller, fund it, pure-SDK mint a cat at the seller ──
  const sellerPriv = secp256k1.utils.randomPrivateKey();
  const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
  const sellerP2 = btc.p2wpkh(sellerPub, regtestNetwork);
  const sellerAddress = sellerP2.address!;
  const sellerScript = sellerP2.script;

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', sellerAddress, String(SELLER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const sellerFundUtxo = await waitForUtxoAt(sellerAddress, Math.round(SELLER_FUND_AMOUNT_BTC * 1e8));

  // Seller mints with a non-cat21wallet walletType so the mint input's
  // sequence is 0xfffffffe — what a third-party wallet would produce.
  const mintBuilt = buildCat21MintPsbt({
    walletType: KnownOrdinalWalletType.xverse,
    network: Network.Regtest,
    fundingInput: {
      txid: sellerFundUtxo.txid,
      vout: sellerFundUtxo.vout,
      value: sellerFundUtxo.value,
      scriptPubKey: sellerScript,
    },
    destinations: {
      recipientAddress: sellerAddress,
      senderChangeAddress: sellerAddress,
    },
    feeSats: MINT_FEE_SATS,
  });
  const mintTx = btc.Transaction.fromPSBT(mintBuilt.psbt);
  mintTx.signIdx(sellerPriv, 0, [btc.SigHash.ALL]);
  mintTx.finalize();
  const mintTxid = await postTx(mintTx.hex);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(mintTxid);
  const sellerCat = (await getUtxos(sellerAddress)).find(u => u.txid === mintTxid && u.vout === 0);
  if (!sellerCat) throw new Error('seller cat UTXO not found after mint');
  expect(sellerCat.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[leather-create-offer] seller owns cat ${mintTxid}:0 at ${sellerAddress}`);

  // ── Leather (buyer) builds + signs the buyer side of the offer (1 popup) ──
  const createSignKnown = new Set(context.pages());
  const createPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'createOffer' as const,
      walletType: 'leather' as const,
      sellerInput: {
        txid: mintTxid,
        vout: 0,
        value: CAT21_POSTAGE_SATS,
        scriptPubKeyHex: bytesHex(sellerScript),
      },
      buyerInputs: [{
        txid: walletFundUtxo.txid,
        vout: walletFundUtxo.vout,
        value: walletFundUtxo.value,
        scriptPubKeyHex: bytesHex(btc.p2wpkh(hexBytes(walletMainnet.paymentPublicKey), regtestNetwork).script),
      }],
      paymentAddress,
      buyerReceiveAddress: ordinalsAddress,
      sellerPaymentAddress: sellerAddress,
      buyerChangeAddress: paymentAddress,
      priceSats: PRICE_SATS,
      feeSats: OFFER_FEE_SATS,
    },
  );
  await approveSignPopup(context, createSignKnown, '02-create-offer-sign');
  const created = await createPromise;
  if (created.kind !== 'createOffer') throw new Error('expected createOffer result');

  const buyerSignedPsbtBytes = hexBytes(created.signedPsbtHex);
  // eslint-disable-next-line no-console
  console.log(`[leather-create-offer] buyer (Leather) signed input 1; PSBT is ${buyerSignedPsbtBytes.byteLength} bytes`);

  // ── Seller-side validator gate (the same gate a seller's accept flow
  // ──  runs against the buyer-pre-signed PSBT before adding a signature) ──
  const validation = validateCat21BuyOfferPsbt({
    psbt: buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: sellerAddress,
    network: Network.Regtest,
  });
  expect(validation.ok).toBe(true);

  // ── Seller raw-key signs input 0, finalize, broadcast ──
  const finalTx = btc.Transaction.fromPSBT(buyerSignedPsbtBytes);
  finalTx.signIdx(sellerPriv, 0, [btc.SigHash.ALL]);
  finalTx.finalize();
  const acceptTxid = await postTx(finalTx.hex);
  // eslint-disable-next-line no-console
  console.log(`[leather-create-offer] offer-acceptance broadcast txid = ${acceptTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // Neither Leather (buyer) nor the seller mutated non-witness bytes
  // between the unsigned PSBT and broadcast (SegWit txid is witness-
  // independent, SIGHASH_ALL commits to those bytes).
  expect(acceptTxid, 'non-witness bytes must survive both signing steps (createOffer flow)')
    .toBe(created.expectedTxid);

  // ── electrs is the authority: the cat's 546-sat output-0 UTXO landed
  // at Leather's buyer-receive (ordinals) address. ──
  const catAtBuyer = await waitForUtxoAt(ordinalsAddress, CAT21_POSTAGE_SATS);
  expect(catAtBuyer.txid).toBe(acceptTxid);
  expect(catAtBuyer.vout).toBe(0);
  const buyerCatUtxo = (await getUtxos(ordinalsAddress)).find(u => u.txid === acceptTxid && u.vout === 0);
  if (!buyerCatUtxo) throw new Error('cat UTXO not found at buyer-receive address');
  expect(buyerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // The seller's cat UTXO is spent.
  expect((await getUtxos(sellerAddress)).find(u => u.txid === mintTxid && u.vout === 0)).toBeUndefined();

  // The seller was paid the agreed price plus the postage (ord parity —
  // output 1 = priceSats + 546).
  const sellerPayment = (await getUtxos(sellerAddress)).find(u => u.txid === acceptTxid);
  if (!sellerPayment) throw new Error('seller payment UTXO not found');
  expect(sellerPayment.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);

  // Every cat-touching tx we build re-mints (lockTime=21), so the
  // acceptance tx itself parses as a CAT-21.
  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
  // eslint-disable-next-line no-console
  console.log(`[leather-create-offer] cat delivered to buyer ${ordinalsAddress} in ${acceptTxid}`);
});
