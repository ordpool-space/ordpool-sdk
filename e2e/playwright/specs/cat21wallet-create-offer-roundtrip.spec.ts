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
import { buildCat21MintPsbt } from '../../../src/cat21-mint/cat21-mint.helper';
import { validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * Cat21 Wallet CREATE-OFFER roundtrip on regtest — wallet is the BUYER.
 *
 * 1. Onboard the wallet, connect on regtest.
 * 2. Fund the wallet via bitcoind.
 * 3. Synthesise a SELLER keypair (raw P2WPKH). Fund the seller via
 *    bitcoind. Pure-SDK mint a cat at the seller's address (raw-key
 *    signs input 0). Cat lives on the seller's bcrt1q UTXO.
 * 4. Wallet builds a buy-offer PSBT against the seller's cat with the
 *    wallet's own funding UTXO at input 1. Wallet signs input 1 via
 *    signOfferCreatePsbt (1 popup); input 0 (the seller's cat) stays
 *    UNSIGNED on emit per the buyer-initiated PSBT contract.
 * 5. Seller (raw key) signs input 0 SIGHASH_ALL, finalizes, broadcasts.
 * 6. Assert: lockTime=21, SIGHASH_ALL on every input, ord agrees the
 *    cat now belongs to the wallet's buyer-receive address,
 *    Cat21ParserService parses the acceptance tx as a CAT-21.
 *
 * This spec pins signOfferCreatePsbt end-to-end: the wallet's
 * partial-sign-no-broadcast path is the buyer's contribution to a
 * trustless offer. The seller-side `validateCat21BuyOfferPsbt` is
 * also exercised here against the buyer-pre-signed PSBT before the
 * raw-key seller adds their signature, mirroring the gate the
 * wallet's own acceptOffer flow runs.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/cat21wallet');
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
    path: path.resolve(RESULTS_DIR, `cat21wallet-create-offer-${name}.png`),
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

test('build + sign a CAT-21 buy-offer on regtest via Cat21 Wallet: seller raw-key mints, wallet signs buyer-side, seller signs input 0', async () => {
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

  // ── Fund wallet ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', wallet.paymentAddress, String(FUND_AMOUNT_BTC));
  let tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdReady();
  await waitForOrdSync(tip);
  const walletFundUtxo = await waitForUtxoAt(wallet.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-create-offer] wallet funded utxo ${walletFundUtxo.txid}:${walletFundUtxo.vout} (${walletFundUtxo.value} sats)`);

  // ── Synthesise seller, fund, raw-key mint ──
  const sellerPriv = secp256k1.utils.randomPrivateKey();
  const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
  const sellerP2 = btc.p2wpkh(sellerPub, regtestNetwork);
  const sellerAddress = sellerP2.address!;
  const sellerScript = sellerP2.script;

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', sellerAddress, String(SELLER_FUND_AMOUNT_BTC));
  tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdSync(tip);
  const sellerFundUtxo = await waitForUtxoAt(sellerAddress, Math.round(SELLER_FUND_AMOUNT_BTC * 1e8));

  // Seller mints with a non-cat21wallet walletType so sequence=0xfffffffe
  // — matches what a third-party wallet would produce.
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
  tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdSync(tip);
  await waitForTxConfirmed(mintTxid);
  const inscriptionId = catInscriptionId(mintTxid);
  const sellerCatInsc = await waitForCatAtAddress(inscriptionId, sellerAddress);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-create-offer] seller now owns cat #${sellerCatInsc.number} at ${sellerAddress}`);

  // ── Wallet builds + signs buyer-side of the offer (1 popup) ──
  const createSignKnown = new Set(context.pages());
  const createPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'createOffer' as const,
      walletType: 'cat21wallet' as const,
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
        scriptPubKeyHex: bytesHex(btc.p2wpkh(hexBytes(wallet.paymentPublicKey), regtestNetwork).script),
      }],
      paymentAddress: wallet.paymentAddress,
      buyerReceiveAddress: wallet.ordinalsAddress,
      sellerPaymentAddress: sellerAddress,
      buyerChangeAddress: wallet.paymentAddress,
      priceSats: PRICE_SATS,
      feeSats: OFFER_FEE_SATS,
    },
  );
  // Wallet (buyer) signs ONLY its funding input at index 1. Pin to signAtIndex=1.
  await approveSignPopup(context, createSignKnown, '02-create-offer-sign', /* signAtIndex */ 1);
  const created = await createPromise;
  if (created.kind !== 'createOffer') throw new Error('expected createOffer result');

  const buyerSignedPsbtBytes = hexBytes(created.signedPsbtHex);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-create-offer] buyer (wallet) signed input 1; PSBT is ${buyerSignedPsbtBytes.byteLength} bytes`);

  // ── Seller-side validator gate (the same gate the wallet's own accept
  // ──  flow would run if the wallet were on the other side) ──
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
  console.log(`[cat21wallet-create-offer] offer-acceptance broadcast txid = ${acceptTxid}`);

  tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdSync(tip);

  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // Locktime-preservation: neither wallet (buyer) nor seller mutated
  // non-witness bytes between unsigned PSBT and broadcast. Point 12.
  expect(acceptTxid, 'non-witness bytes must survive both signing steps (createOffer flow)')
    .toBe(created.expectedTxid);
  // Fee + sequence. Points 8 + 9.
  expect(acceptTx.fee, `offer-accept fee = ${OFFER_FEE_SATS} sats`).toBe(OFFER_FEE_SATS);
  assertEveryInputSequence(acceptTx, 0xfffffffd, 'createOffer-accept');

  // cat21-ord is the authority. Point 7.
  const finalInsc = await waitForCatAtAddress(inscriptionId, wallet.ordinalsAddress);
  expect(finalInsc.address).toBe(wallet.ordinalsAddress);
  expect(finalInsc.value).toBe(CAT21_POSTAGE_SATS);
  expect(finalInsc.number).toBe(sellerCatInsc.number);

  // Seller actually got paid the agreed price (net of postage).
  const sellerUtxosAfter = await getUtxos(sellerAddress);
  const payment = sellerUtxosAfter.find(u => u.txid === acceptTxid);
  expect(payment).toBeTruthy();
  expect(payment!.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);

  // ─── Adversarial PSBT validation tests (audit point 6) ───
  // The wallet's createOffer flow emits a buyer-pre-signed PSBT that
  // a SELLER then validates before signing input 0. Exercise the
  // seller-side validator against mutated PSBTs.
  await runAdversarialValidatorChecks({
    buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: sellerAddress,
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

/** See cat21wallet-transfer-roundtrip.spec.ts. */
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
 * See cat21wallet-accept-offer-roundtrip.spec.ts for the full
 * rationale; this is the same adversarial-PSBT battery scoped to a
 * different "expected seller payment address" (the raw-key seller).
 */
async function runAdversarialValidatorChecks(args: {
  buyerSignedPsbtBytes: Uint8Array;
  expectedSellerUtxo: { txid: string; vout: number };
  floorPriceSats: number;
  expectedSellerPaymentAddress: string;
  regtestNetwork: typeof btc.NETWORK;
}): Promise<void> {
  const okValidation = validateCat21BuyOfferPsbt({
    psbt: args.buyerSignedPsbtBytes,
    expectedSellerUtxo: args.expectedSellerUtxo,
    floorPriceSats: args.floorPriceSats,
    expectedSellerPaymentAddress: args.expectedSellerPaymentAddress,
    network: Network.Regtest,
  });
  expect(okValidation.ok, 'canonical PSBT must validate ok=true').toBe(true);

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
