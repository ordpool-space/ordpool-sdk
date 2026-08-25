import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
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
import { waitForApprovalPopup } from '../approval-popup';
import { Network, toScureNetwork } from '../../../src/network';
import { buildCat21BuyOfferPsbt, validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * Xverse ACCEPT-OFFER roundtrip on regtest — Xverse is the SELLER.
 *
 * The Xverse CI shard runs ONLY bitcoind + electrs (NOT cat21-ord), so
 * "did the cat move" is asserted via electrs + the parser, never ord.
 *
 * Flow:
 *   1. Unlock the seeded (regtest) Xverse wallet, connect → native
 *      bcrt1q payment + bcrt1p ordinals addresses. Fund the wallet.
 *   2. Mint a cat via Xverse (1 sign popup). Cat lands at the wallet's
 *      bcrt1p ordinals address.
 *   3. Synthesise a BUYER keypair (raw P2WPKH). Fund it.
 *   4. Buyer (raw key, off-wallet) builds a buy-offer PSBT against the
 *      wallet's cat UTXO via `buildCat21BuyOfferPsbt`, signs their own
 *      input 1 (SIGHASH_ALL). Input 0 (the cat) stays unsigned — the
 *      seller's job.
 *   5. Hand the buyer-pre-signed PSBT to
 *      `runOperation({kind:'acceptOffer'})`. Xverse signs input 0 (its
 *      Taproot cat) via 1 legacy `signTransaction` popup. The harness
 *      captures the finalized wire tx; the spec broadcasts via electrs.
 *   6. Assert via electrs + parser: the cat's 546-sat output-0 UTXO now
 *      sits at the buyer's address, lockTime=21, SIGHASH_ALL on every
 *      input, and the parser recognises the acceptance tx as a CAT-21.
 *
 * The acceptance tx exercises the wallet's signOfferAccept method
 * end-to-end against a real chain: SIGHASH_ALL pinning + lockTime=21
 * bonus-mint against the real Xverse binary.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const TEST_PASSWORD = 'TestPassword123!';
const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../../test-results/xverse-seed-user-data-dir');

const FUND_AMOUNT_BTC = 0.001;
const BUYER_FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const OFFER_FEE_SATS = 1500;
const PRICE_SATS = 50_000;
const CAT21_POSTAGE_SATS = 546;

// Xverse mint inputs carry the RBF-off sequence (2024 Xverse-Accelerate
// mint-RBF defence). Offer builders use RBF-on (0xfffffffd) for EVERY
// wallet — cat already on chain. See `src/cat21-protocol/cat21-sequence.ts`.
const MINT_SEQUENCE = 0xfffffffe;
const OFFER_SEQUENCE = 0xfffffffd;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: path.resolve(RESULTS_DIR, `xverse-accept-offer-${name}.png`), fullPage: true }).catch(() => undefined);
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
function xOnlyHex(pubHex: string): string {
  const s = pubHex.startsWith('0x') ? pubHex.slice(2) : pubHex;
  return s.length === 66 ? s.slice(2) : s;
}

function assertEveryInputSequence(tx: { vin: unknown[] }, expected: number, label: string): void {
  tx.vin.forEach((raw, i) => {
    const v = raw as { sequence?: number; is_coinbase?: boolean };
    if (v.is_coinbase) return;
    if (typeof v.sequence !== 'number') {
      throw new Error(`${label}: vin[${i}] missing sequence in electrs response`);
    }
    expect(v.sequence, `${label}: vin[${i}].sequence`).toBe(expected);
  });
}

/**
 * Approve one Xverse "Review transaction" sign popup and wait for it to
 * close. Copied from `xverse-inscribe-child-roundtrip.spec.ts` — every
 * cat-flow operation drives Xverse's legacy `signTransaction` popup.
 */
async function approveXverseSignPopup(ctx: BrowserContext, knownPages: Set<Page>, tag: string): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 120_000,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByText(/(review|sign|confirm)\b.*\b(transaction|psbt)/i).first().waitFor({ state: 'visible', timeout: 120_000 });
      return true;
    },
  });
  await shot(approval, tag);
  await approval.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(b => {
      if (!/^(confirm|sign|approve)$/i.test(b.textContent?.trim() ?? '')) return false;
      if (b.hasAttribute('disabled')) return false;
      const style = getComputedStyle(b);
      return style.pointerEvents !== 'none' && style.visibility !== 'hidden';
    });
  }, undefined, { timeout: 30_000, polling: 250 });
  knownPages.add(approval);
  for (let attempt = 0; attempt < 4 && !approval.isClosed(); attempt++) {
    await approval.getByRole('button', { name: /^(confirm|sign|approve)$/i }).first().click({ force: true }).catch(() => undefined);
    const closed = await new Promise<boolean>((res) => {
      if (approval.isClosed()) return res(true);
      const t = setTimeout(() => res(false), 15_000);
      approval.once('close', () => { clearTimeout(t); res(true); });
    });
    if (closed) break;
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) throw new Error(`Xverse extension not unpacked at ${EXT_PATH}.`);
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  if (!fs.existsSync(path.join(SEED_USER_DATA_DIR, 'Default'))) throw new Error(`Xverse seed user-data-dir missing at ${SEED_USER_DATA_DIR}.`);
  try {
    execFileSync('docker', ['exec', 'ordpool-e2e-bitcoind', 'bitcoin-cli', '-regtest', '-rpcuser=ordpool', '-rpcpassword=ordpool', 'getblockchaininfo'], { stdio: 'ignore' });
  } catch (e) {
    throw new Error(`bitcoind regtest container not reachable: ${(e as Error).message}`);
  }
  const tip = Number(rpc('getblockcount').trim());
  if (tip < 101) throw new Error(`regtest tip is ${tip} (<101). Run e2e/regtest-bootstrap.sh before this spec.`);

  const workingDir = `${SEED_USER_DATA_DIR}.acceptofferspec-${process.pid}-${Date.now()}`;
  fs.cpSync(SEED_USER_DATA_DIR, workingDir, { recursive: true });
  for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(workingDir, stale), { force: true });
  }
  context = await chromium.launchPersistentContext(workingDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

// fixme (Xverse-specific, fix identified — deferred): Xverse's modern
// signPsbt HANGS (10-min test timeout, confirmed on CI run 32797046889)
// when the PSBT's input 1 is already signed by the buyer. Transfer,
// create-offer (foreign but UNSIGNED input) and child-reveal all sign fine
// via the same bare `request('signPsbt')` path — the buyer's pre-signed
// foreign input is the specific trigger. The fix is the bare-sign-then-merge
// pattern (like signChildRevealParentInputs): present Xverse a copy with
// input 1 reduced to its witnessUtxo (buyer sig stripped), sign input 0,
// then merge input 0's key-path sig back onto the full buyer-signed PSBT and
// finalize. That rebuild must preserve version + lockTime=21 + sequence
// exactly or the merged sig is invalid, so it needs a local PSBT test before
// shipping. Un-fixme once signOfferAccept does the strip+merge for Xverse.
test.fixme('accept a CAT-21 buy offer on regtest via Xverse (seller): mint, buyer builds PSBT, Xverse signs input 0, verify via electrs/parser', async () => {
  test.setTimeout(600_000);
  const regtestNetwork = toScureNetwork(Network.Regtest);

  // ── Unlock ──
  const primer = await context.newPage();
  await primer.setViewportSize({ width: 400, height: 800 });
  await primer.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await primer.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('unlock') || t.includes('account 1');
  }, undefined, { timeout: 30_000, polling: 250 });
  if (/unlock/i.test(await primer.locator('body').innerText())) {
    await primer.locator('input[type="password"]').first().fill(TEST_PASSWORD);
    await primer.getByRole('button', { name: /^unlock$/i }).first().click();
    await primer.waitForFunction(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return t.includes('account 1') || t.includes('not now') || t.includes('send');
    }, undefined, { timeout: 30_000, polling: 250 });
  }
  const notNow = primer.getByText('Not now', { exact: true }).first();
  if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await notNow.click({ force: true }).catch(() => undefined);
  }

  // ── Connect (native bcrt1q / bcrt1p on regtest) ──
  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(() => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true, undefined, { timeout: 15_000 });

  const connectPagePromise = context.waitForEvent('page', { timeout: 60_000 });
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectXverse('regtest'));
  const approvalConnect = await connectPagePromise;
  await approvalConnect.waitForLoadState('domcontentloaded');
  await approvalConnect.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return ['connect', 'approve', 'confirm', 'allow'].some(s => t.includes(s));
  }, undefined, { timeout: 60_000, polling: 500 });
  await approvalConnect.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first().click();
  const wallet = await connectResultPromise;
  await approvalConnect.close().catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log(`[xverse-accept-offer] seller payment=${wallet.paymentAddress} ordinals=${wallet.ordinalsAddress}`);
  expect(wallet.paymentAddress).toMatch(/^bcrt1q/);
  expect(wallet.ordinalsAddress).toMatch(/^bcrt1p/);

  // ── Fund the seller (Xverse) wallet ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', wallet.paymentAddress, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(wallet.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ── Step 1: MINT via Xverse (1 sign popup) ──
  const mintSignKnown = new Set(context.pages());
  const mintPromise = harness.evaluate((args) => window.ordpoolSdkHarness.runOperation(args), {
    kind: 'mint' as const,
    walletType: 'xverse' as const,
    utxo: { txid: fundUtxo.txid, vout: fundUtxo.vout, value: fundUtxo.value },
    paymentAddress: wallet.paymentAddress,
    paymentPublicKey: wallet.paymentPublicKey,
    recipientAddress: wallet.ordinalsAddress,
    feeSats: MINT_FEE_SATS,
  });
  await approveXverseSignPopup(context, mintSignKnown, '01-mint-sign');
  const minted = await mintPromise;
  if (minted.kind !== 'mint') throw new Error('expected mint result');
  const mintTxid = await postTx(minted.txHex);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  expect(mintTxid, 'wallet must not modify non-witness bytes (mint)').toBe(minted.expectedTxid);
  // Mint inputs are RBF-off (>= 0xfffffffe). Match the proven
  // xverse-mint-roundtrip assertion style (`>=`, not exact).
  mintTx.vin.forEach((raw, i) => {
    const v = raw as { sequence?: number; is_coinbase?: boolean };
    if (v.is_coinbase) return;
    expect(v.sequence, `mint vin[${i}].sequence`).toBeGreaterThanOrEqual(MINT_SEQUENCE);
  });
  // Cat lives on the wallet's bcrt1p ordinals UTXO (vout 0, 546 sats).
  // Poll electrs (the per-address history pass lags the confirmed tip).
  const sellerCatUtxo = await waitForUtxoMatching(
    wallet.ordinalsAddress,
    u => u.txid === mintTxid && u.vout === 0,
    `seller cat ${mintTxid}:0 at ordinalsAddress`,
  );
  expect(sellerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[xverse-accept-offer] wallet owns cat ${mintTxid}:0 at ${wallet.ordinalsAddress}`);

  // ── Step 2: synthesise buyer keypair + fund it ──
  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyerPub = secp256k1.getPublicKey(buyerPriv, true);
  const buyerP2 = btc.p2wpkh(buyerPub, regtestNetwork);
  const buyerAddress = buyerP2.address!;
  const buyerScript = buyerP2.script;
  // eslint-disable-next-line no-console
  console.log(`[xverse-accept-offer] buyer address = ${buyerAddress}`);

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', buyerAddress, String(BUYER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const buyerFundUtxo = await waitForUtxoAt(buyerAddress, Math.round(BUYER_FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[xverse-accept-offer] buyer funded utxo ${buyerFundUtxo.txid}:${buyerFundUtxo.vout} (${buyerFundUtxo.value} sats)`);

  // ── Step 3: the seller's cat scriptPubKey (Taproot, BIP-86 ordinals) ──
  // Taproot scriptPubKey = OP_1 || 0x20 || TWEAKED output key; the PSBT's
  // tapInternalKey (not needed here — the buyer only sets witnessUtxo)
  // carries the UNTWEAKED internal key.
  const ordinalsXOnlyHex = xOnlyHex(wallet.ordinalsPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only ordinals pubkey').toBe(64);
  const sellerCatScript = btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script;

  // ── Step 4: buyer builds the offer PSBT via the SDK ──
  // walletType only tags the buyer's wallet; the offer builder pins
  // sequence 0xfffffffd (RBF-on) regardless of it.
  const offer = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.xverse,
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

  // ── Buyer signs input 1 (their own funding) SIGHASH_ALL ──
  const offerTx = btc.Transaction.fromPSBT(offer.psbt);
  offerTx.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);
  const buyerSignedPsbtBytes = offerTx.toPSBT();
  // eslint-disable-next-line no-console
  console.log(`[xverse-accept-offer] buyer signed input 1; handing PSBT (${buyerSignedPsbtBytes.byteLength} bytes) to Xverse`);

  // Sanity: the seller-side validator accepts this PSBT (the same gate
  // the wallet's accept flow runs before signing).
  const validation = validateCat21BuyOfferPsbt({
    psbt: buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: wallet.paymentAddress,
    network: Network.Regtest,
  });
  expect(validation.ok).toBe(true);

  // ── Step 5: Xverse signs input 0 (its Taproot cat) — 1 popup ──
  const acceptSignKnown = new Set(context.pages());
  const acceptPromise = harness.evaluate((args) => window.ordpoolSdkHarness.runOperation(args), {
    kind: 'acceptOffer' as const,
    walletType: 'xverse' as const,
    psbtHex: bytesHex(buyerSignedPsbtBytes),
    ordinalsAddress: wallet.ordinalsAddress,
  });
  await approveXverseSignPopup(context, acceptSignKnown, '02-accept-sign');
  const accepted = await acceptPromise;
  if (accepted.kind !== 'acceptOffer') throw new Error('expected acceptOffer result');

  const acceptTxid = await postTx(accepted.txHex);
  // eslint-disable-next-line no-console
  console.log(`[xverse-accept-offer] accept broadcast txid = ${acceptTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // SegWit txid is witness-independent — Xverse must not mutate
  // non-witness bytes between the buyer-pre-signed PSBT and broadcast.
  expect(acceptTxid, 'wallet must not modify non-witness bytes (acceptOffer)').toBe(accepted.expectedTxid);
  expect(acceptTx.fee, `accept fee = ${OFFER_FEE_SATS} sats`).toBe(OFFER_FEE_SATS);
  assertEveryInputSequence(acceptTx, OFFER_SEQUENCE, 'acceptOffer');

  // ── electrs is the authority — the cat's 546-sat output-0 UTXO now
  //     sits at the buyer's address ──
  const buyerCatUtxo = await waitForUtxoMatching(
    buyerAddress,
    u => u.txid === acceptTxid && u.vout === 0,
    `cat ${acceptTxid}:0 at buyer address`,
  );
  expect(buyerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // The cat left the wallet's ordinals address (positive proof it moved).
  expect((await getUtxos(wallet.ordinalsAddress)).find(u => u.txid === mintTxid && u.vout === 0)).toBeUndefined();

  // ── Seller (Xverse) actually got paid the agreed price (net of postage) ──
  const payment = (await getUtxos(wallet.paymentAddress)).find(u => u.txid === acceptTxid);
  if (!payment) throw new Error('seller payment UTXO not found at Xverse payment address');
  expect(payment.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[xverse-accept-offer] cat now at ${buyerAddress}; Xverse paid ${payment.value} sats`);

  // ── Parser agrees the acceptance tx is a CAT-21 (lockTime=21 re-mint) ──
  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
