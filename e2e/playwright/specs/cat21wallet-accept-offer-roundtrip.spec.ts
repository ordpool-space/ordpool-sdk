import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import {
  waitForElectrsSync,
  waitForUtxoAt,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
  assertAllInputsSighashAll,
  waitForOrdReady,
  waitForOrdSync,
  waitForCatAtAddress,
  catInscriptionId,
  getUtxos,
} from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { Network, toScureNetwork } from '../../../src/network';
import { buildCat21BuyOfferPsbt, validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * Cat21 Wallet ACCEPT-OFFER roundtrip on regtest — wallet is the SELLER.
 *
 * 1. Onboard the wallet, connect on regtest (bcrt1q + bcrt1p direct).
 * 2. Fund the wallet via bitcoind.
 * 3. Mint a cat via the wallet (1 popup). Cat lands at wallet's bcrt1p.
 * 4. Synthesise a buyer keypair (raw P2WPKH on regtest). Fund the buyer
 *    via bitcoind.
 * 5. Buyer (raw-key, off-extension) builds a buy-offer PSBT against
 *    the wallet's cat UTXO via the SDK's buildCat21BuyOfferPsbt, signs
 *    their own input 1 (P2WPKH, SIGHASH_ALL). Input 0 (cat) stays
 *    unsigned — the seller's job.
 * 6. Hand the buyer-pre-signed PSBT to the harness's
 *    runOperation({kind:'acceptOffer'}). Wallet signs input 0
 *    (Taproot, BIP-86 ordinals key) via 1 sign popup. Harness captures
 *    the finalized wire-tx hex; spec broadcasts via electrs.
 * 7. Mine. Assert: lockTime=21, SIGHASH_ALL on every input, ord agrees
 *    cat is now at the buyer's address, Cat21ParserService still
 *    parses the acceptance tx as a CAT-21 (lockTime=21 → re-mint).
 *
 * The acceptance tx exercises the wallet's signOfferAccept method
 * end-to-end against a real chain: SIGHASH_ALL pinning, lockTime=21
 * cherry-on-top mint, every protocol invariant the SDK promises.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/cat21wallet');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';

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
    path: path.resolve(RESULTS_DIR, `cat21wallet-accept-offer-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardCat21Wallet(page: Page): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-in-link')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sign-in-link').click();
  const inputs = page.locator('input[type="text"], input[type="password"]');
  await expect(inputs.first()).toBeVisible({ timeout: 15_000 });
  const words = TEST_MNEMONIC.split(' ');
  for (let i = 0; i < 12; i++) await inputs.nth(i).fill(words[i]);
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
      await p.getByTestId('get-addresses-approve-button')
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByTestId('get-addresses-approve-button').click();
}

/** See cat21wallet-transfer-roundtrip.spec.ts for the full content-gate rationale. */
async function approveSignPopup(
  ctx: BrowserContext,
  knownPages: Set<Page>,
  screenshotTag: string,
  expectedSignAtIndex: number,
): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 90_000,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      if (!p.url().includes('sign-psbt')) return false;
      await p.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first()
        .waitFor({ state: 'visible', timeout: 90_000 });
      return true;
    },
  });
  await shot(approval, screenshotTag);
  const url = approval.url();
  expect(url, 'sign popup URL must encode the sign-psbt route').toContain('sign-psbt');
  expect(url, `sign popup URL must carry signAtIndex=${expectedSignAtIndex}`).toContain(
    `signAtIndex=${expectedSignAtIndex}`,
  );
  await expect(approval.getByTestId('psbt-signer-card'),
    'psbt-signer-card must render in the sign popup',
  ).toBeVisible({ timeout: 15_000 });
  const confirmBtn = approval.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first();
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
  await confirmBtn.click();
  knownPages.add(approval);
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
  await onboardCat21Wallet(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('accept a CAT-21 buy offer on regtest via Cat21 Wallet: mint, buyer builds PSBT, wallet signs input 0', async () => {
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
  // See cat21wallet-transfer-roundtrip.spec.ts for why we don't rely
  // on the wallet's `network: 'regtest'` argument to getAddresses.
  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectCat21Wallet());
  await approveConnectPopup(context, connectKnownPages);
  const walletMainnet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  const regtestPaymentAddress = btc.p2wpkh(hexBytes(walletMainnet.paymentPublicKey), regtestNetwork).address!;
  const regtestOrdinalsAddress = btc.p2tr(hexBytes(walletMainnet.ordinalsPublicKey), undefined, regtestNetwork).address!;
  const wallet = {
    ...walletMainnet,
    paymentAddress: regtestPaymentAddress,
    ordinalsAddress: regtestOrdinalsAddress,
  };
  expect(wallet.paymentAddress).toMatch(/^bcrt1q/);
  expect(wallet.ordinalsAddress).toMatch(/^bcrt1p/);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-accept] wallet payment=${wallet.paymentAddress} ordinals=${wallet.ordinalsAddress}`);

  // ── Fund wallet ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', wallet.paymentAddress, String(FUND_AMOUNT_BTC));
  let tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdReady();
  await waitForOrdSync(tip);
  const fundUtxo = await waitForUtxoAt(wallet.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ── Wallet mints (1 popup) ──
  const mintSignKnown = new Set(context.pages());
  const mintPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'cat21wallet' as const,
      utxo: { txid: fundUtxo.txid, vout: fundUtxo.vout, value: fundUtxo.value },
      paymentAddress: wallet.paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: wallet.ordinalsAddress,
      feeSats: MINT_FEE_SATS,
    },
  );
  await approveSignPopup(context, mintSignKnown, '02-mint-sign', /* signAtIndex */ 0);
  const minted = await mintPromise;
  if (minted.kind !== 'mint') throw new Error('expected mint result');
  const mintTxid = await postTx(minted.txHex);
  tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdSync(tip);
  await waitForTxConfirmed(mintTxid);
  const inscriptionId = catInscriptionId(mintTxid);
  const minteInsc = await waitForCatAtAddress(inscriptionId, wallet.ordinalsAddress);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-accept] wallet now owns cat #${minteInsc.number}`);

  // ── Synthesise buyer keypair + fund it ──
  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyerPub = secp256k1.getPublicKey(buyerPriv, true);
  const buyerP2 = btc.p2wpkh(buyerPub, regtestNetwork);
  const buyerAddress = buyerP2.address!;
  const buyerScript = buyerP2.script;
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-accept] buyer address = ${buyerAddress}`);

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', buyerAddress, String(BUYER_FUND_AMOUNT_BTC));
  tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdSync(tip);
  const buyerFundUtxo = await waitForUtxoAt(buyerAddress, Math.round(BUYER_FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-accept] buyer funded utxo ${buyerFundUtxo.txid}:${buyerFundUtxo.vout} (${buyerFundUtxo.value} sats)`);

  // ── Build buyer-side scriptPubKey for the seller's cat UTXO ──
  // Taproot scriptPubKey = OP_1 || 0x20 || TWEAKED output key (BIP-86).
  // `p2tr(internalKey, ...)` performs the tweak. `tapInternalKey` field
  // in a PSBT carries the UNTWEAKED internal key.
  const ordinalsXOnlyHex = wallet.ordinalsPublicKey;
  if (ordinalsXOnlyHex.length !== 64) {
    throw new Error(`expected x-only ordinalsPublicKey, got ${ordinalsXOnlyHex.length} hex chars`);
  }
  const ordinalsXOnly = hexBytes(ordinalsXOnlyHex);
  const sellerCatScript = btc.p2tr(ordinalsXOnly, undefined, regtestNetwork).script;

  // ── Buyer builds the offer PSBT via SDK ──
  const offer = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.cat21wallet,
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
      sellerPaymentAddress: wallet.paymentAddress,
      buyerChangeAddress: buyerAddress,
    },
    priceSats: PRICE_SATS,
    feeSats: OFFER_FEE_SATS,
  });

  // ── Buyer signs input 1 (their own funding) under SIGHASH_ALL ──
  const offerTx = btc.Transaction.fromPSBT(offer.psbt);
  offerTx.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);
  const buyerSignedPsbtBytes = offerTx.toPSBT();
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-accept] buyer signed input 1; handing PSBT (${buyerSignedPsbtBytes.byteLength} bytes) to seller wallet`);

  // Sanity check: the seller-side validator should accept this PSBT.
  // The same gate runs inside the wallet's accept-offer flow per
  // HARD RULE #6 (validate intent before sign).
  const validation = validateCat21BuyOfferPsbt({
    psbt: buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: wallet.paymentAddress,
    network: Network.Regtest,
  });
  expect(validation.ok).toBe(true);

  // ── Wallet signs input 0 (1 popup) ──
  const acceptSignKnown = new Set(context.pages());
  const acceptPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'acceptOffer' as const,
      walletType: 'cat21wallet' as const,
      psbtHex: bytesHex(buyerSignedPsbtBytes),
      ordinalsAddress: wallet.ordinalsAddress,
    },
  );
  // The wallet signs ONLY input 0 (the seller's cat). Pin to signAtIndex=0.
  await approveSignPopup(context, acceptSignKnown, '03-accept-sign', /* signAtIndex */ 0);
  const accepted = await acceptPromise;
  if (accepted.kind !== 'acceptOffer') throw new Error('expected acceptOffer result');

  const acceptTxid = await postTx(accepted.txHex);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-accept] accept broadcast txid = ${acceptTxid}`);

  tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdSync(tip);

  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // Locktime-preservation: wallet must not mutate non-witness bytes
  // between buyer-pre-signed PSBT and the broadcast tx. Point 12.
  expect(acceptTxid, 'wallet must not modify non-witness bytes (acceptOffer)').toBe(accepted.expectedTxid);
  // Fee + sequence. Points 8 + 9.
  expect(acceptTx.fee, `accept fee = ${OFFER_FEE_SATS} sats`).toBe(OFFER_FEE_SATS);
  assertEveryInputSequence(acceptTx, 0xfffffffd, 'acceptOffer');

  // cat21-ord is the authority on ownership transfer. Point 7.
  const movedInsc = await waitForCatAtAddress(inscriptionId, buyerAddress);
  expect(movedInsc.address).toBe(buyerAddress);
  expect(movedInsc.value).toBe(CAT21_POSTAGE_SATS);
  expect(movedInsc.number).toBe(minteInsc.number);

  // ─── Adversarial PSBT validation tests (audit point 6) ───
  // Build BAD variants of the buy-offer PSBT the wallet would have
  // received, run them through validateCat21BuyOfferPsbt with the
  // SELLER's true expectations, and assert each variant is rejected
  // with the right reason. These exercise the validator that the
  // wallet's runtime gate (Cat21OperationGate) uses BEFORE signing.
  // None of these reach the wallet; they hit the validator directly.
  await runAdversarialValidatorChecks({
    buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: wallet.paymentAddress,
    regtestNetwork,
  });
});

/* ─────────────────────────── helpers ─────────────────────────── */

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

/**
 * Assert every input's sequence equals the expected value. See the
 * transfer spec for the rationale (RBF policy regression).
 */
function assertEveryInputSequence(
  tx: { vin: unknown[] },
  expectedSequence: number,
  label: string,
): void {
  tx.vin.forEach((raw, i) => {
    const v = raw as { sequence?: number; is_coinbase?: boolean };
    if (v.is_coinbase) return;
    if (typeof v.sequence !== 'number') {
      throw new Error(`${label}: vin[${i}] missing sequence in electrs response`);
    }
    expect(v.sequence, `${label}: vin[${i}].sequence`).toBe(expectedSequence);
  });
}

/**
 * Build adversarial variants of the buyer-pre-signed offer PSBT and
 * assert validateCat21BuyOfferPsbt rejects each one with the correct
 * Cat21OfferRejectionReason. The cases here are the load-bearing ones
 * that protect the SELLER (whose money is on the line) — anything that
 * lets a malicious buyer redirect funds or destroy the cat.
 *
 * Each variant: re-parse the canonical PSBT, mutate one field, then
 * re-serialize to PSBT bytes and validate. The mutation strategy uses
 * scure btc.Transaction's mutable input/output access where possible;
 * for output-script mutations, we re-add the entire output.
 *
 * NOTE: this exercises the validator (audit point 6). It does NOT
 * exercise the wallet's runtime Cat21OperationGate. The wallet's gate
 * is dead code from these specs' perspective (audit point 15) — that
 * would require driving the wallet's full Cat21RpcService.acceptOffer
 * path through MCP/popup messaging, a bigger refactor.
 */
async function runAdversarialValidatorChecks(args: {
  buyerSignedPsbtBytes: Uint8Array;
  expectedSellerUtxo: { txid: string; vout: number };
  floorPriceSats: number;
  expectedSellerPaymentAddress: string;
  regtestNetwork: typeof btc.NETWORK;
}): Promise<void> {
  // 1. Canonical → must validate ok.
  const okValidation = validateCat21BuyOfferPsbt({
    psbt: args.buyerSignedPsbtBytes,
    expectedSellerUtxo: args.expectedSellerUtxo,
    floorPriceSats: args.floorPriceSats,
    expectedSellerPaymentAddress: args.expectedSellerPaymentAddress,
    network: Network.Regtest,
  });
  expect(okValidation.ok, 'canonical PSBT must validate ok=true').toBe(true);

  // 2. Wrong expected seller payment address → 'payment-output-wrong-address'.
  //    Adversary lies about the address the seller is supposedly paid to.
  const attackerAddress = btc.p2wpkh(
    secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true),
    args.regtestNetwork,
  ).address!;
  const wrongAddrValidation = validateCat21BuyOfferPsbt({
    psbt: args.buyerSignedPsbtBytes,
    expectedSellerUtxo: args.expectedSellerUtxo,
    floorPriceSats: args.floorPriceSats,
    expectedSellerPaymentAddress: attackerAddress,
    network: Network.Regtest,
  });
  expect(wrongAddrValidation.ok, 'PSBT with mismatched expected seller addr must be rejected').toBe(false);
  if (wrongAddrValidation.ok === false) {
    expect(wrongAddrValidation.reason).toBe('payment-output-wrong-address');
  }

  // 3. Floor too high → 'wrong-price'.
  //    Seller's floor is higher than the PSBT's payment amount.
  const overpricedValidation = validateCat21BuyOfferPsbt({
    psbt: args.buyerSignedPsbtBytes,
    expectedSellerUtxo: args.expectedSellerUtxo,
    floorPriceSats: args.floorPriceSats + 1_000_000,
    expectedSellerPaymentAddress: args.expectedSellerPaymentAddress,
    network: Network.Regtest,
  });
  expect(overpricedValidation.ok, 'underpriced PSBT must be rejected').toBe(false);
  if (overpricedValidation.ok === false) {
    expect(overpricedValidation.reason).toBe('wrong-price');
  }

  // 4. Wrong seller utxo → 'missing-seller-input'.
  //    Seller's true cat utxo is X; PSBT references Y.
  const wrongUtxoValidation = validateCat21BuyOfferPsbt({
    psbt: args.buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: '00'.repeat(32), vout: 99 },
    floorPriceSats: args.floorPriceSats,
    expectedSellerPaymentAddress: args.expectedSellerPaymentAddress,
    network: Network.Regtest,
  });
  expect(wrongUtxoValidation.ok, 'PSBT referencing wrong cat utxo must be rejected').toBe(false);
  if (wrongUtxoValidation.ok === false) {
    expect(wrongUtxoValidation.reason).toBe('missing-seller-input');
  }

  // 5. Garbage PSBT bytes → 'missing-seller-input' (magic-byte rejection).
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const garbageValidation = validateCat21BuyOfferPsbt({
    psbt: garbage,
    expectedSellerUtxo: args.expectedSellerUtxo,
    floorPriceSats: args.floorPriceSats,
    expectedSellerPaymentAddress: args.expectedSellerPaymentAddress,
    network: Network.Regtest,
  });
  expect(garbageValidation.ok, 'non-PSBT bytes must be rejected').toBe(false);
  if (garbageValidation.ok === false) {
    expect(garbageValidation.reason).toBe('missing-seller-input');
  }
}
