import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

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
import { onboardOkx } from '../onboard-okx';
import { Network, toScureNetwork } from '../../../src/network';
import { buildCat21MintPsbt } from '../../../src/cat21-mint/cat21-mint.helper';
import { validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * OKX cat21 CREATE-OFFER roundtrip on regtest — OKX is the BUYER.
 * Asserted through electrs + the parser (this CI shard runs bitcoind +
 * electrs only, NOT cat21-ord).
 *
 * 1. Onboard OKX (`onboardOkx`), connect, derive the regtest bcrt1p.
 * 2. Fund OKX's bcrt1p (the buyer's funding UTXO).
 * 3. Synthesise a SELLER raw keypair (P2WPKH). Fund it, pure-SDK mint a
 *    cat at the seller (raw-key signs input 0). The cat lives on the
 *    seller's bcrt1q UTXO.
 * 4. OKX builds a buy-offer PSBT against the seller's cat with OKX's own
 *    funding at input 1, and signs input 1 via runOperation(createOffer)
 *    (1 popup). Input 0 (the seller's cat) stays UNSIGNED on emit.
 * 5. Seller-side validator gates the buyer-signed PSBT, then the seller
 *    raw-key signs input 0, finalizes, broadcasts via local electrs.
 * 6. Assert via electrs: the cat's 546-sat output-0 UTXO now sits at
 *    OKX's buyer-receive address; the seller was paid; the acceptance tx
 *    carries lockTime=21 across all inputs under SIGHASH_ALL; the parser
 *    reads it as a CAT-21.
 *
 * Pins signOfferCreatePsbt end-to-end: OKX's partial-sign-no-broadcast
 * path is the buyer's contribution to a trustless offer. The buyer's
 * funding input is Taproot (OKX single-address, payment === ordinals),
 * with no envelope input, so OKX's signPsbt preview handles it.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;
const SELLER_FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const OFFER_FEE_SATS = 1500;
const PRICE_SATS = 50_000;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;
let onboardPage: Page | null = null;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `okx-create-offer-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  // Anchor on the "Connect account" page header — copied EXACTLY from
  // okx-mint-roundtrip.spec.ts (OKX opens a stray sign popup during
  // connect that loose button matching would wrongly accept).
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByText('Connect account').first()
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByRole('button', { name: /^connect$/i }).first().click();
}

async function approveSignPopup(ctx: BrowserContext, tag: string): Promise<void> {
  // Poll every chrome-extension page for the sign-popup heading. Heading
  // varies across OKX versions: "Signature request" (new) vs "Confirm
  // Trade" (legacy) vs an "Asset transfer pending" promo overlay. Copied
  // from okx-mint-roundtrip.spec.ts.
  const deadline = Date.now() + 120_000;
  let approval: Page | null = null;
  let lastLog = 0;
  const seenSnapshots = new Set<string>();
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if (!p.url().startsWith('chrome-extension://')) continue;
      const text = await p.locator('body').innerText().catch(() => '');
      if (/Signature request|Confirm Trade|Asset transfer pending/i.test(text)) {
        approval = p;
        break;
      }
      const snippet = (text.split('\n').find(s => s.trim().length > 0) ?? '').slice(0, 80);
      const key = `${p.url()}|${snippet}`;
      if (!seenSnapshots.has(key)) {
        seenSnapshots.add(key);
        console.log(`[okx-create-offer:diag] page url=${p.url().slice(0, 100)} first-line="${snippet}"`);
      }
    }
    if (approval) break;
    if (Date.now() - lastLog > 10_000) {
      console.log(`[okx-create-offer:diag] waiting for ${tag} sign popup… pages=${ctx.pages().length}`);
      lastLog = Date.now();
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!approval) throw new Error(`OKX ${tag} sign popup never showed Signature request | Confirm Trade within 120s`);
  await shot(approval, `${tag}-sign-approval`);

  const promoModalText = approval.getByText('Asset transfer pending');
  if (await promoModalText.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const closeBtn = approval.locator('button:has(svg), [aria-label="close" i], [aria-label="Close" i]').first();
    if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await closeBtn.click({ force: true }).catch(() => undefined);
    }
    await promoModalText.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }
  await shot(approval, `${tag}-post-modal-dismiss`);
  await approval.getByText('Confirm', { exact: true }).first().click();
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`OKX extension not unpacked at ${EXT_PATH}.`);
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
      '--disable-blink-features=AutomationControlled',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

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

// fixme: OKX cannot sign this — the same wallet-side limitation as the child
// reveal. A buy-offer PSBT always carries a FOREIGN input (here the seller's
// unsigned cat input at index 0), and OKX's closed signPsbt preview cannot
// render a PSBT that contains a not-owned input (proven for the child reveal:
// signPsbt hangs with no popup). OKX transfer/mint/inscribe — every input
// OKX-owned — work; only PSBTs with a foreign input are blocked, wallet-side.
// (A hanging signPsbt also poisons the shared OKX shard, so fixme-ing this
// keeps the shard's mint/inscribe/transfer specs green.) Un-fixme only if
// OKX's preview learns to render a not-owned input.
test('build + sign a CAT-21 buy-offer on regtest via OKX (buyer): seller raw-key mints, OKX signs input 1, seller signs input 0, assert via electrs', async () => {
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

  // ── Connect ──
  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOkx());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  expect(wallet.paymentAddress).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');

  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  const okxBcrt1p = regtest.ordinalsAddress;
  expect(okxBcrt1p).toMatch(/^bcrt1p/);
  const okxXOnlyHex = wallet.paymentPublicKey.length === 66
    ? wallet.paymentPublicKey.slice(2)
    : wallet.paymentPublicKey;
  if (okxXOnlyHex.length !== 64) throw new Error(`expected x-only key, got ${okxXOnlyHex.length} hex chars`);
  const okxTaprootScriptHex = bytesHex(btc.p2tr(hexBytes(okxXOnlyHex), undefined, regtestNetwork).script);
  console.log(`[okx-create-offer] buyer (OKX) bcrt1p = ${okxBcrt1p}`);

  // ── Fund OKX (the buyer funding UTXO) ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', okxBcrt1p, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const buyerFundUtxo = await waitForUtxoAt(okxBcrt1p, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ── Synthesise seller, fund, pure-SDK raw-key mint ──
  const sellerPriv = secp256k1.utils.randomPrivateKey();
  const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
  const sellerP2 = btc.p2wpkh(sellerPub, regtestNetwork);
  const sellerAddress = sellerP2.address!;
  const sellerScript = sellerP2.script;

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', sellerAddress, String(SELLER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const sellerFundUtxo = await waitForUtxoAt(sellerAddress, Math.round(SELLER_FUND_AMOUNT_BTC * 1e8));

  // Seller mints with a non-cat21wallet walletType so sequence=0xfffffffe
  // (what a third-party wallet produces).
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
  const sellerMintTx = btc.Transaction.fromPSBT(mintBuilt.psbt);
  sellerMintTx.signIdx(sellerPriv, 0, [btc.SigHash.ALL]);
  sellerMintTx.finalize();
  const mintTxid = await postTx(sellerMintTx.hex);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  const mintParsed = Cat21ParserService.parse(mintTx);
  expect(mintParsed).not.toBeNull();
  expect(mintParsed!.type).toBe(DigitalArtifactType.Cat21);
  // The cat lives on the seller's 546-sat output-0 UTXO.
  const sellerCatUtxo = await waitForUtxoMatching(
    sellerAddress,
    u => u.txid === mintTxid && u.vout === 0,
    `seller cat ${mintTxid}:0`,
  );
  expect(sellerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  console.log(`[okx-create-offer] seller ${sellerAddress} owns cat ${mintTxid}:0`);

  // ── OKX builds + signs the buyer side of the offer (1 popup) ──
  // The signing-hint address (paymentAddress) MUST be OKX's MAINNET
  // bc1p — OKX validates each toSignInputs row against its own mainnet
  // address set. PSBT-embedded output addresses + input scriptPubKeys
  // stay regtest (script bytes are HRP-independent).
  const createPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'createOffer' as const,
      walletType: 'okx' as const,
      sellerInput: {
        txid: mintTxid,
        vout: 0,
        value: CAT21_POSTAGE_SATS,
        scriptPubKeyHex: bytesHex(sellerScript),
      },
      buyerInputs: [{
        txid: buyerFundUtxo.txid,
        vout: buyerFundUtxo.vout,
        value: buyerFundUtxo.value,
        scriptPubKeyHex: okxTaprootScriptHex,
      }],
      paymentAddress: wallet.paymentAddress,
      buyerReceiveAddress: okxBcrt1p,
      sellerPaymentAddress: sellerAddress,
      buyerChangeAddress: okxBcrt1p,
      priceSats: PRICE_SATS,
      feeSats: OFFER_FEE_SATS,
    },
  );
  let createSignError: Error | null = null;
  createPromise.catch((e) => { createSignError = e as Error; });
  try {
    await approveSignPopup(context, '02-create-offer');
  } catch (popupErr) {
    if (createSignError) throw new Error(`okx createOffer signPsbt rejected before popup opened: ${(createSignError as Error).message}`);
    throw popupErr;
  }
  const created = await createPromise;
  if (created.kind !== 'createOffer') throw new Error('expected createOffer result');
  await closeLeftoverExtensionPages(context, connectKnownPages);

  const buyerSignedPsbtBytes = hexBytes(created.signedPsbtHex);
  console.log(`[okx-create-offer] OKX (buyer) signed input 1; PSBT is ${buyerSignedPsbtBytes.byteLength} bytes`);

  // ── Seller-side validator gate ──
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
  console.log(`[okx-create-offer] offer-acceptance broadcast txid = ${acceptTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // Non-witness bytes survive both signing steps.
  expect(acceptTxid, 'non-witness bytes must survive both signing steps (createOffer)').toBe(created.expectedTxid);
  expect(acceptTx.fee, `offer-accept fee = ${OFFER_FEE_SATS} sats`).toBe(OFFER_FEE_SATS);
  // No sequence assertion: the offer builder pins 0xfffffffd (RBF-on for
  // every wallet on offers) — not the mint RBF-off policy.

  // ── Assert via electrs: cat at OKX's buyer-receive address ──
  const catAtBuyer = await waitForUtxoMatching(
    okxBcrt1p,
    u => u.txid === acceptTxid && u.vout === 0,
    `cat at buyer ${acceptTxid}:0`,
  );
  expect(catAtBuyer.value).toBe(CAT21_POSTAGE_SATS);

  // Seller actually got paid the agreed price (net of postage).
  const sellerUtxosAfter = await getUtxos(sellerAddress);
  const payment = sellerUtxosAfter.find(u => u.txid === acceptTxid);
  expect(payment).toBeTruthy();
  expect(payment!.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);

  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
  console.log(`[okx-create-offer] cat now at OKX buyer-receive ${okxBcrt1p}`);

  // ─── Adversarial PSBT validation battery (seller-side gate) ───
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

/**
 * Build adversarial variants of the buyer-pre-signed offer PSBT and
 * assert validateCat21BuyOfferPsbt rejects each with the correct reason.
 * Exercises the seller-side gate the wallet's own accept flow runs. None
 * of these reach OKX; they hit the validator directly.
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
    expect(garbageValidation.reason).toBe('malformed-offer-psbt');
  }
}
