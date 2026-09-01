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
import { buildCat21BuyOfferPsbt, validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * Unisat CAT-21 ACCEPT-OFFER roundtrip on regtest — Unisat is the SELLER.
 * Asserted through electrs + ordpool-parser (NO ord: the Unisat CI shard
 * runs bitcoind + electrs only).
 *
 * 1. Onboard Unisat in BIP-86 Taproot (P2TR) mode, connect.
 * 2. Fund Unisat's bcrt1p, mint a cat via Unisat (1 popup). Cat lands at
 *    Unisat's bcrt1p.
 * 3. Synthesise a BUYER raw P2WPKH keypair, fund it.
 * 4. Buyer (raw-key, off-extension) builds a buy-offer PSBT against Unisat's
 *    cat UTXO via buildCat21BuyOfferPsbt, signs their own input 1 (P2WPKH,
 *    SIGHASH_ALL). Input 0 (cat) stays unsigned — the seller's job.
 * 5. Seller-side validator gate accepts the buyer-pre-signed PSBT.
 * 6. Hand the PSBT to runOperation({kind:'acceptOffer'}). Unisat signs input
 *    0 (the Taproot cat) via 1 sign popup. Broadcast via electrs.
 * 7. Assert via electrs: cat's 546-sat UTXO now at the buyer's bcrt1q
 *    output 0; seller got paid priceSats+postage; lockTime=21; SIGHASH_ALL
 *    on every input; Cat21ParserService parses the tx.
 *
 * Unisat signs ONLY with its ACTIVE account key and matches inputs by
 * address, so it is onboarded in Taproot (P2TR) mode: the single active key
 * is the taproot key that owns the cat. The harness passes the signer's
 * `ordinalsAddress` through verbatim, so the spec hands Unisat its MAINNET
 * bc1p address for the active-account match; the PSBT carries regtest bytes.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

// BIP-86 Taproot derivation of `abandon × 11 + about` on mainnet — the
// value unisat-matrix.spec.ts pins for the P2TR variant, and the value
// Unisat matches `toSignInputs` against in Taproot mode.
const UNISAT_MAINNET_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

const FUND_AMOUNT_BTC = 0.001;
const BUYER_FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const OFFER_FEE_SATS = 1500;
const PRICE_SATS = 50_000;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `unisat-accept-offer-${name}.png`),
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

/**
 * Wait for a Unisat sign popup, approve it, and register it in
 * `knownPages` so the NEXT call skips it (this flow fires two sequential
 * sign popups: the mint, then the accept).
 */
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
  // Taproot address type (card index 2): the single active account IS the
  // taproot key that owns the cat, so the accept flow signs input 0 with it.
  await onboardUnisat(onboardPage, extensionId, { addressTypeIndex: 2 });
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('accept a CAT-21 buy offer on regtest via Unisat (Taproot mode, SELLER): mint, buyer builds PSBT, Unisat signs input 0', async () => {
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

  // Mainnet address Unisat matches `toSignInputs` against for the accept
  // signer path; the PSBT still carries regtest bytes.
  const mainnetTaproot = wallet.paymentAddress;

  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  const walletTaproot = regtest.ordinalsAddress;
  expect(walletTaproot).toMatch(/^bcrt1p/);
  const ordinalsXOnlyHex = xOnlyHex(wallet.paymentPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only taproot pubkey').toBe(64);
  const ordinalsXOnly = hexBytes(ordinalsXOnlyHex);
  // eslint-disable-next-line no-console
  console.log(`[unisat-accept] wallet taproot = ${walletTaproot}`);

  // ── Fund Unisat ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', walletTaproot, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(walletTaproot, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ── Unisat mints its own cat (1 popup). The mint path threads the pubkey
  // ── so the harness shims paymentAddress to mainnet; keep regtest addrs ──
  const mintSignKnown = new Set(context.pages());
  const mintPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'unisat' as const,
      utxo: { txid: fundUtxo.txid, vout: fundUtxo.vout, value: fundUtxo.value },
      paymentAddress: walletTaproot,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: walletTaproot,
      feeSats: MINT_FEE_SATS,
    },
  );
  await approveSignPopup(context, mintSignKnown, '02-mint-sign');
  const minted = await mintPromise;
  if (minted.kind !== 'mint') throw new Error('expected mint result');
  const mintTxid = await postTx(minted.txHex);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  // Cat-sat RBF guard on the MINT, mirrored from unisat-mint-roundtrip.
  for (const vin of mintTx.vin) {
    expect((vin as { sequence: number }).sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }
  const mintParsed = Cat21ParserService.parse(mintTx);
  expect(mintParsed).not.toBeNull();
  expect(mintParsed!.type).toBe(DigitalArtifactType.Cat21);
  // The cat lives on Unisat's 546-sat output-0 UTXO.
  const catUtxo = await waitForUtxoMatching(
    walletTaproot,
    u => u.txid === mintTxid && u.vout === 0,
    `Unisat cat ${mintTxid}:0`,
  );
  expect(catUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[unisat-accept] Unisat owns cat ${mintTxid}:0`);

  // ── Synthesise buyer (raw P2WPKH) + fund ──
  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyerPub = secp256k1.getPublicKey(buyerPriv, true);
  const buyerP2 = btc.p2wpkh(buyerPub, regtestNetwork);
  const buyerAddress = buyerP2.address!;
  const buyerScript = buyerP2.script;
  // eslint-disable-next-line no-console
  console.log(`[unisat-accept] buyer address = ${buyerAddress}`);

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', buyerAddress, String(BUYER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const buyerFundUtxo = await waitForUtxoAt(buyerAddress, Math.round(BUYER_FUND_AMOUNT_BTC * 1e8));

  // ── Seller's (Unisat's) cat is a Taproot key-path UTXO; its scriptPubKey
  // ── is the BIP-86 tweaked output key. Payment goes to Unisat's bcrt1p ──
  const sellerCatScript = btc.p2tr(ordinalsXOnly, undefined, regtestNetwork).script;

  // ── Buyer builds the offer PSBT via SDK, signs input 1 (P2WPKH) ──
  const offer = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.unisat,
    network: Network.Regtest,
    sellerInput: {
      txid: mintTxid,
      vout: 0,
      value: CAT21_POSTAGE_SATS,
      scriptPubKey: sellerCatScript,
    },
    buyerInputs: [{
      txid: buyerFundUtxo.txid,
      vout: buyerFundUtxo.vout,
      value: buyerFundUtxo.value,
      scriptPubKey: buyerScript,
    }],
    destinations: {
      buyerReceiveAddress: buyerAddress,
      sellerPaymentAddress: walletTaproot,
      buyerChangeAddress: buyerAddress,
    },
    priceSats: PRICE_SATS,
    feeSats: OFFER_FEE_SATS,
  });
  const offerTx = btc.Transaction.fromPSBT(offer.psbt);
  offerTx.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);
  const buyerSignedPsbtBytes = offerTx.toPSBT();
  // eslint-disable-next-line no-console
  console.log(`[unisat-accept] buyer signed input 1; handing PSBT (${buyerSignedPsbtBytes.byteLength} bytes) to Unisat`);

  // Seller-side validator gate (the same gate the wallet's accept flow
  // runs before signing).
  const validation = validateCat21BuyOfferPsbt({
    psbt: buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: walletTaproot,
    network: Network.Regtest,
  });
  expect(validation.ok).toBe(true);

  // ── Unisat signs input 0 (Taproot cat, 1 popup). ordinalsAddress hint is
  // ── the wallet's MAINNET bc1p so its active-account match succeeds ──
  const acceptSignKnown = new Set(context.pages());
  const acceptPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'acceptOffer' as const,
      walletType: 'unisat' as const,
      psbtHex: bytesHex(buyerSignedPsbtBytes),
      ordinalsAddress: mainnetTaproot,
    },
  );
  await approveSignPopup(context, acceptSignKnown, '03-accept-sign');
  const accepted = await acceptPromise;
  if (accepted.kind !== 'acceptOffer') throw new Error('expected acceptOffer result');

  const acceptTxid = await postTx(accepted.txHex);
  // eslint-disable-next-line no-console
  console.log(`[unisat-accept] accept broadcast txid = ${acceptTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // Non-witness-tamper guard: Unisat must not mutate non-witness bytes
  // between the buyer-pre-signed PSBT and the broadcast tx.
  expect(acceptTxid, 'Unisat must not modify non-witness bytes (acceptOffer)').toBe(accepted.expectedTxid);
  // Exact fee (funding clears dust; no sub-dust absorb).
  expect(acceptTx.fee, `accept fee = ${OFFER_FEE_SATS} sats`).toBe(OFFER_FEE_SATS);
  // No sequence assertion: the offer builder pins 0xfffffffd (RBF-on for
  // every wallet on offers), NOT the mint RBF-off policy.

  // ── Assert via ELECTRS: cat's 546-sat UTXO now at the buyer's bcrt1q
  // ── output 0 ──
  const movedCat = await waitForUtxoMatching(
    buyerAddress,
    u => u.txid === acceptTxid && u.vout === 0,
    `cat at buyer ${acceptTxid}:0`,
  );
  expect(movedCat.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[unisat-accept] cat now at ${buyerAddress} (${movedCat.txid}:${movedCat.vout})`);

  // Seller (Unisat) got paid priceSats + postage at their bcrt1p address.
  const sellerUtxosAfter = await getUtxos(walletTaproot);
  const payment = sellerUtxosAfter.find(u => u.txid === acceptTxid);
  if (!payment) throw new Error('seller payment UTXO not found at Unisat address');
  expect(payment.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);

  // ── Assert via ordpool-parser: the acceptance tx is itself a CAT-21 ──
  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
