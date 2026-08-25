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
import { buildCat21BuyOfferPsbt, validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * Leather ACCEPT-OFFER roundtrip on regtest — Leather is the SELLER.
 * Proves the real Leather binary signs the seller side of a CAT-21
 * buy-offer end-to-end (the Taproot cat input, input 0). Turns the SDK
 * matrix's `leather / acceptOffer` adapter cell into `proven`.
 *
 * The Leather CI shard runs ONLY bitcoind + electrs (no cat21-ord), so
 * ownership is asserted against electrs + the parser, never ord.
 *
 * Flow:
 *  1. Onboard Leather, connect on mainnet, derive regtest addresses
 *     inline (seller payment bcrt1q, seller ordinals bcrt1p).
 *  2. Fund the Leather (seller) payment address via bitcoind.
 *  3. Mint a cat via Leather (1 popup). Cat lands at the wallet's REAL
 *     BIP-86 ordinals address so Leather can sign it back out on accept.
 *  4. Synthesise a BUYER raw P2WPKH keypair; fund it.
 *  5. Buyer (raw key, off-extension) builds a buy-offer PSBT against the
 *     wallet's cat via buildCat21BuyOfferPsbt and signs their own input
 *     1 (P2WPKH, SIGHASH_ALL). Input 0 (the cat) stays unsigned.
 *  6. Hand the buyer-pre-signed PSBT to runOperation({kind:'acceptOffer'}).
 *     Leather signs input 0 (Taproot, BIP-86 ordinals key) via 1 popup.
 *  7. Broadcast via local electrs; mine. Assert via electrs: the cat's
 *     546-sat output-0 UTXO lands at the buyer's address, the seller
 *     (Leather) is paid priceSats + postage, lockTime=21, SIGHASH_ALL on
 *     every input, and the acceptance tx parses as a CAT-21.
 *
 * Network: Leather signs input 0 (Taproot) with its mainnet BIP-86 key
 * (the signer shim maps regtest → mainnet). Schnorr commits to script
 * bytes not the bech32 HRP, so the signature verifies against the
 * regtest PSBT whose tapInternalKey is the wallet's mainnet ordinals key.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');
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
    path: path.resolve(RESULTS_DIR, `leather-accept-offer-${name}.png`),
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
/** Normalise a pubkey hex to x-only (32 bytes): drop the 0x02/0x03 parity byte if present. */
function xOnlyHex(pubHex: string): string {
  const s = pubHex.startsWith('0x') ? pubHex.slice(2) : pubHex;
  return s.length === 66 ? s.slice(2) : s;
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
 * `knownPages`. The mint fires one popup; the accept fires one popup
 * (Leather signs only input 0, the Taproot cat). Leather's sign surface
 * has no stable testid; match by the Confirm/Sign/Approve button.
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
  knownPages.add(approval);
  try {
    await confirmBtn.click({ timeout: 10_000 });
  } catch (e) {
    // Leather closes the sign popup the instant it accepts the click, so the
    // click can race that close. The click registered before the close; a
    // genuine non-approval surfaces downstream (the signer never resolves).
    if (!/(target page|context or browser).*closed|has been closed/i.test(e instanceof Error ? e.message : String(e))) {
      throw e;
    }
  }
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

test('accept a CAT-21 buy offer on regtest via Leather (seller): mint, buyer builds PSBT, Leather signs input 0 (Taproot cat)', async () => {
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

  const ordinalsXOnlyHex = xOnlyHex(walletMainnet.ordinalsPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only ordinals pubkey').toBe(64);
  const paymentAddress = btc.p2wpkh(hexBytes(walletMainnet.paymentPublicKey), regtestNetwork).address!;
  const ordinalsAddress = btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).address!;
  expect(paymentAddress).toMatch(/^bcrt1q/);
  expect(ordinalsAddress).toMatch(/^bcrt1p/);
  // eslint-disable-next-line no-console
  console.log(`[leather-accept] seller payment=${paymentAddress} ordinals=${ordinalsAddress}`);

  // ── Fund the Leather (seller) payment address ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', paymentAddress, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ── Step 1: MINT via Leather (1 popup). Cat lands at ordinalsAddress ──
  const mintSignKnown = new Set(context.pages());
  const mintPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'leather' as const,
      utxo: { txid: fundUtxo.txid, vout: fundUtxo.vout, value: fundUtxo.value },
      paymentAddress,
      paymentPublicKey: walletMainnet.paymentPublicKey,
      recipientAddress: ordinalsAddress,
      feeSats: MINT_FEE_SATS,
    },
  );
  await approveSignPopup(context, mintSignKnown, '02-mint-sign');
  const minted = await mintPromise;
  if (minted.kind !== 'mint') throw new Error('expected mint result');
  const mintTxid = await postTx(minted.txHex);
  // eslint-disable-next-line no-console
  console.log(`[leather-accept] mint broadcast txid = ${mintTxid}`);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  expect(mintTxid, 'wallet must not modify non-witness bytes (mint)').toBe(minted.expectedTxid);
  // Cat-sat guard on the MINT input: RBF-final (>= 0xfffffffe) — Leather's
  // mint RBF-off policy. Same assertion as leather-mint-roundtrip.spec.ts.
  for (const vin of mintTx.vin as { sequence: number }[]) {
    expect(vin.sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }
  const sellerCat = (await getUtxos(ordinalsAddress)).find(u => u.txid === mintTxid && u.vout === 0);
  if (!sellerCat) throw new Error('cat UTXO not found at ordinalsAddress after mint');
  expect(sellerCat.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[leather-accept] Leather (seller) owns cat ${mintTxid}:0 at ${ordinalsAddress}`);

  // ── Step 2: synthesise a buyer keypair + fund it ──
  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyerPub = secp256k1.getPublicKey(buyerPriv, true);
  const buyerP2 = btc.p2wpkh(buyerPub, regtestNetwork);
  const buyerAddress = buyerP2.address!;
  const buyerScript = buyerP2.script;
  // eslint-disable-next-line no-console
  console.log(`[leather-accept] buyer address = ${buyerAddress}`);

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', buyerAddress, String(BUYER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const buyerFundUtxo = await waitForUtxoAt(buyerAddress, Math.round(BUYER_FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[leather-accept] buyer funded utxo ${buyerFundUtxo.txid}:${buyerFundUtxo.vout} (${buyerFundUtxo.value} sats)`);

  // ── Step 3: buyer builds the offer PSBT against Leather's cat ──
  // The seller's cat scriptPubKey is the Taproot output OP_1 || 0x20 ||
  // TWEAKED output key (BIP-86); p2tr(internalKey, …) performs the tweak.
  const sellerCatScript = btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script;
  const offer = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.leather,
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
      sellerPaymentAddress: paymentAddress,
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
  console.log(`[leather-accept] buyer signed input 1; handing PSBT (${buyerSignedPsbtBytes.byteLength} bytes) to Leather`);

  // Seller-side validator gate — the same check a seller's accept flow
  // runs BEFORE signing (validate intent before sign).
  const validation = validateCat21BuyOfferPsbt({
    psbt: buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: paymentAddress,
    network: Network.Regtest,
  });
  expect(validation.ok).toBe(true);

  // ── Step 4: Leather (seller) signs input 0 (1 popup) ──
  const acceptSignKnown = new Set(context.pages());
  const acceptPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'acceptOffer' as const,
      walletType: 'leather' as const,
      psbtHex: bytesHex(buyerSignedPsbtBytes),
      ordinalsAddress,
    },
  );
  await approveSignPopup(context, acceptSignKnown, '03-accept-sign');
  const accepted = await acceptPromise;
  if (accepted.kind !== 'acceptOffer') throw new Error('expected acceptOffer result');

  const acceptTxid = await postTx(accepted.txHex);
  // eslint-disable-next-line no-console
  console.log(`[leather-accept] accept broadcast txid = ${acceptTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // Leather must not mutate non-witness bytes between the buyer-pre-signed
  // PSBT and the broadcast tx (SegWit txid is witness-independent).
  expect(acceptTxid, 'wallet must not modify non-witness bytes (acceptOffer)').toBe(accepted.expectedTxid);

  // ── electrs is the authority: the cat's 546-sat output-0 UTXO landed
  // at the buyer's address (the buyer's change also lands there, but 546
  // is unique to the cat). ──
  const catAtBuyer = await waitForUtxoAt(buyerAddress, CAT21_POSTAGE_SATS);
  expect(catAtBuyer.txid).toBe(acceptTxid);
  expect(catAtBuyer.vout).toBe(0);
  const buyerCatUtxo = (await getUtxos(buyerAddress)).find(u => u.txid === acceptTxid && u.vout === 0);
  if (!buyerCatUtxo) throw new Error('cat UTXO not found at buyer address');
  expect(buyerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // Leather's cat UTXO is spent.
  expect((await getUtxos(ordinalsAddress)).find(u => u.txid === mintTxid && u.vout === 0)).toBeUndefined();

  // The seller (Leather) was paid the agreed price plus postage at its
  // payment address (output 1 = priceSats + 546).
  const sellerPayment = (await getUtxos(paymentAddress)).find(u => u.txid === acceptTxid);
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
  console.log(`[leather-accept] cat delivered to buyer ${buyerAddress} in ${acceptTxid}`);
});
