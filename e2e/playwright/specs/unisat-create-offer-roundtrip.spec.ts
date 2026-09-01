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
  waitForUtxoMatching,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
  assertAllInputsSighashAll,
  getUtxos,
} from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { onboardUnisat } from '../onboard-unisat';
import { buildCat21MintPsbt } from '../../../src/cat21-mint/cat21-mint.helper';
import { validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * Unisat CAT-21 CREATE-OFFER roundtrip on regtest — Unisat is the BUYER.
 * Asserted through electrs + ordpool-parser (NO ord: the Unisat CI shard
 * runs bitcoind + electrs only).
 *
 * 1. Onboard Unisat in BIP-86 Taproot (P2TR) mode, connect.
 * 2. Fund Unisat's bcrt1p with a buyer funding UTXO.
 * 3. Synthesise a SELLER raw P2WPKH keypair, fund it, pure-SDK mint a cat
 *    at the seller (raw key signs input 0). Cat lives on the seller's
 *    bcrt1q UTXO.
 * 4. Unisat builds a buy-offer PSBT against the seller's cat with Unisat's
 *    own taproot funding UTXO at input 1. Unisat signs input 1 via
 *    signOfferCreatePsbt (1 popup); input 0 (the seller's cat) stays
 *    UNSIGNED on emit per the buyer-initiated PSBT contract.
 * 5. Seller raw-key signs input 0 SIGHASH_ALL, finalizes, broadcasts.
 * 6. Assert via electrs: cat's 546-sat UTXO now at Unisat's buyer-receive
 *    (bcrt1p) output 0; seller got paid priceSats+postage; lockTime=21;
 *    SIGHASH_ALL on every input; Cat21ParserService parses the tx.
 *
 * signOfferCreatePsbt is the buyer's partial-sign-no-broadcast
 * contribution to a trustless offer — one of the four wallet operations.
 * Unisat's funding input is a Taproot key-path spend (Taproot mode),
 * matched by Unisat's active mainnet bc1p account passed as the signer's
 * `paymentAddress`; the PSBT itself still carries regtest bytes.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

// BIP-86 Taproot derivation of `abandon × 11 + about` on mainnet — the
// value unisat-matrix.spec.ts pins for the P2TR variant, and the value
// Unisat matches `toSignInputs` against in Taproot mode.
const UNISAT_MAINNET_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

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
    path: path.resolve(RESULTS_DIR, `unisat-create-offer-${name}.png`),
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
/** Normalise a pubkey hex to x-only (32 bytes): drop the parity byte if present. */
function xOnlyHex(pubHex: string): string {
  const s = pubHex.startsWith('0x') ? pubHex.slice(2) : pubHex;
  return s.length === 66 ? s.slice(2) : s;
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => {
      await p.waitForURL(/notification\.html#\/approval/, { timeout: 60_000 });
      return true;
    },
  });
  await approval.getByText(/^Connect$/).first().click();
}

/** Wait for a Unisat sign popup and approve it (single popup on this flow). */
async function approveSignPopup(ctx: BrowserContext, knownPages: Set<Page>, tag: string): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 90_000,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByTestId('sign-psbt-button')
        .waitFor({ state: 'visible', timeout: 90_000 });
      return true;
    },
  });
  await shot(approval, tag);
  await approval.getByTestId('sign-psbt-button').click();
  knownPages.add(approval);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Unisat extension not unpacked at ${EXT_PATH}.`);
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
  // Taproot address type (card index 2): the active account IS the taproot
  // key that signs the buyer funding input.
  await onboardUnisat(onboardPage, extensionId, { addressTypeIndex: 2 });
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('build + sign a CAT-21 buy-offer on regtest via Unisat (Taproot mode, BUYER): seller raw-key mints, Unisat signs buyer input, seller signs input 0', async () => {
  test.setTimeout(600_000);
  const regtestNetwork = toScureNetwork(Network.Regtest);

  const harness = await context.newPage();
  // eslint-disable-next-line no-console
  harness.on('console', (m) => console.log(`[H] ${m.text()}`));
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // ── Connect (Taproot mode) ──
  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  expect(wallet.paymentAddress).toBe(UNISAT_MAINNET_TAPROOT);
  expect(wallet.ordinalsAddress).toBe(UNISAT_MAINNET_TAPROOT);

  // Mainnet address Unisat matches `toSignInputs` against for the offer
  // signer path; the PSBT still carries regtest bytes.
  const mainnetTaproot = wallet.paymentAddress;

  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  const walletTaproot = regtest.ordinalsAddress;
  expect(walletTaproot).toMatch(/^bcrt1p/);
  const ordinalsXOnly = hexBytes(xOnlyHex(wallet.paymentPublicKey));
  const walletTaprootScriptHex = bytesHex(btc.p2tr(ordinalsXOnly, undefined, regtestNetwork).script);

  // ── Fund Unisat (buyer) ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', walletTaproot, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const walletFundUtxo = await waitForUtxoAt(walletTaproot, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[unisat-create-offer] buyer funded utxo ${walletFundUtxo.txid}:${walletFundUtxo.vout} (${walletFundUtxo.value} sats)`);

  // ── Synthesise seller (raw P2WPKH), fund, pure-SDK mint ──
  const sellerPriv = secp256k1.utils.randomPrivateKey();
  const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
  const sellerP2 = btc.p2wpkh(sellerPub, regtestNetwork);
  const sellerAddress = sellerP2.address!;
  const sellerScript = sellerP2.script;

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', sellerAddress, String(SELLER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const sellerFundUtxo = await waitForUtxoAt(sellerAddress, Math.round(SELLER_FUND_AMOUNT_BTC * 1e8));

  // Seller mints with a non-cat21wallet walletType (sequence=0xfffffffe),
  // matching what a third-party wallet would produce.
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
  const sellerMintTx = await waitForTxConfirmed(mintTxid);
  expect(sellerMintTx.locktime).toBe(21);
  assertAllInputsSighashAll(sellerMintTx);
  const mintParsed = Cat21ParserService.parse(sellerMintTx);
  expect(mintParsed).not.toBeNull();
  expect(mintParsed!.type).toBe(DigitalArtifactType.Cat21);
  // The cat lives on the seller's 546-sat output-0 UTXO.
  const sellerCat = await waitForUtxoMatching(
    sellerAddress,
    u => u.txid === mintTxid && u.vout === 0,
    `seller cat ${mintTxid}:0`,
  );
  expect(sellerCat.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[unisat-create-offer] seller owns cat ${mintTxid}:0 at ${sellerAddress}`);

  // ── Unisat builds + signs buyer-side of the offer (1 popup) ──
  // buyerReceive / buyerChange are the wallet's regtest bcrt1p (cats land
  // at ordinals); the buyer funding input is Unisat's taproot UTXO, matched
  // by Unisat's mainnet bc1p account via the signer's `paymentAddress`.
  const createSignKnown = new Set(context.pages());
  const createPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'createOffer' as const,
      walletType: 'unisat' as const,
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
        scriptPubKeyHex: walletTaprootScriptHex,
      }],
      paymentAddress: mainnetTaproot,
      buyerReceiveAddress: walletTaproot,
      sellerPaymentAddress: sellerAddress,
      buyerChangeAddress: walletTaproot,
      priceSats: PRICE_SATS,
      feeSats: OFFER_FEE_SATS,
    },
  );
  await approveSignPopup(context, createSignKnown, '02-create-offer-sign');
  const created = await createPromise;
  if (created.kind !== 'createOffer') throw new Error('expected createOffer result');

  const buyerSignedPsbtBytes = hexBytes(created.signedPsbtHex);
  // eslint-disable-next-line no-console
  console.log(`[unisat-create-offer] buyer (Unisat) signed input 1; PSBT is ${buyerSignedPsbtBytes.byteLength} bytes`);

  // ── Seller-side validator gate (the gate a seller runs before signing) ──
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
  console.log(`[unisat-create-offer] offer-acceptance broadcast txid = ${acceptTxid}`);

  await waitForElectrsSync(mineBlocks(1));
  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // Non-witness-tamper guard: neither Unisat (buyer) nor the seller may
  // mutate non-witness bytes between the unsigned PSBT and broadcast.
  expect(acceptTxid, 'non-witness bytes must survive both signing steps (createOffer flow)')
    .toBe(created.expectedTxid);
  // Exact fee (funding clears dust; no sub-dust absorb).
  expect(acceptTx.fee, `offer-accept fee = ${OFFER_FEE_SATS} sats`).toBe(OFFER_FEE_SATS);
  // No sequence assertion: the offer builder pins 0xfffffffd (RBF-on for
  // every wallet on offers), NOT the mint RBF-off policy.

  // ── Assert via ELECTRS: cat's 546-sat UTXO now at Unisat's buyer-receive
  // ── (bcrt1p) output 0 ──
  const boughtCat = await waitForUtxoMatching(
    walletTaproot,
    u => u.txid === acceptTxid && u.vout === 0,
    `cat at buyer ${acceptTxid}:0`,
  );
  expect(boughtCat.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[unisat-create-offer] cat now at ${walletTaproot} (${boughtCat.txid}:${boughtCat.vout})`);

  // Seller actually got paid the agreed price (net of the postage they
  // contributed via input 0): output 1 value = priceSats + postage.
  const sellerUtxosAfter = await getUtxos(sellerAddress);
  const payment = sellerUtxosAfter.find(u => u.txid === acceptTxid);
  if (!payment) throw new Error('seller payment UTXO not found');
  expect(payment.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);

  // ── Assert via ordpool-parser: the acceptance tx is itself a CAT-21 ──
  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
