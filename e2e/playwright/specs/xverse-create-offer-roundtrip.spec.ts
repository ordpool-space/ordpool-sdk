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
import { buildCat21MintPsbt } from '../../../src/cat21-mint/cat21-mint.helper';
import { validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

/**
 * Xverse CREATE-OFFER roundtrip on regtest — Xverse is the BUYER.
 *
 * The Xverse CI shard runs ONLY bitcoind + electrs (NOT cat21-ord), so
 * "did the cat move" is asserted via electrs + the parser, never ord.
 *
 * Flow:
 *   1. Unlock the seeded (regtest) Xverse wallet, connect → native
 *      bcrt1q payment + bcrt1p ordinals addresses. Fund the wallet.
 *   2. Synthesise a SELLER keypair (raw P2WPKH). Fund it, then pure-SDK
 *      mint a cat at the seller (raw key signs input 0). Cat lives on
 *      the seller's bcrt1q UTXO.
 *   3. Xverse builds a buy-offer PSBT against the seller's cat with its
 *      own funding UTXO at input 1, and signs input 1 via
 *      `runOperation({kind:'createOffer'})` (1 legacy `signTransaction`
 *      popup). Input 0 (the seller's cat) stays UNSIGNED on emit per the
 *      buyer-initiated PSBT contract.
 *   4. Seller (raw key) signs input 0 SIGHASH_ALL, finalize, broadcast.
 *   5. Assert via electrs + parser: the cat's 546-sat output-0 UTXO now
 *      sits at Xverse's buyer-receive (ordinals) address, the seller got
 *      paid `priceSats` (net of postage), lockTime=21, SIGHASH_ALL on
 *      every input, and the parser recognises the acceptance tx as a
 *      CAT-21.
 *
 * This pins signOfferCreatePsbt end-to-end: the wallet's
 * partial-sign-no-broadcast path is the buyer's contribution to a
 * trustless offer. The seller-side `validateCat21BuyOfferPsbt` gate is
 * exercised here against the buyer-pre-signed PSBT before the raw-key
 * seller signs, mirroring the gate a wallet's own accept flow runs.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const TEST_PASSWORD = 'TestPassword123!';
const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../../test-results/xverse-seed-user-data-dir');

const FUND_AMOUNT_BTC = 0.001;
const SELLER_FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const OFFER_FEE_SATS = 1500;
const PRICE_SATS = 50_000;
const CAT21_POSTAGE_SATS = 546;

// Offer builders use `CAT21_WALLET_INPUT_SEQUENCE` (RBF-on) for EVERY
// wallet — the cat is already on chain, so a marker-less RBF replacement
// only loses a bonus mint, never the cat. See
// `src/cat21-protocol/cat21-sequence.ts` + `cat21-offer.helper.ts`.
const OFFER_SEQUENCE = 0xfffffffd;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: path.resolve(RESULTS_DIR, `xverse-create-offer-${name}.png`), fullPage: true }).catch(() => undefined);
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

  const workingDir = `${SEED_USER_DATA_DIR}.createofferspec-${process.pid}-${Date.now()}`;
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

test('build + sign a CAT-21 buy-offer on regtest via Xverse (buyer): seller raw-key mints, Xverse signs input 1, seller signs input 0, verify via electrs/parser', async () => {
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
  console.log(`[xverse-create-offer] buyer payment=${wallet.paymentAddress} ordinals=${wallet.ordinalsAddress}`);
  expect(wallet.paymentAddress).toMatch(/^bcrt1q/);
  expect(wallet.ordinalsAddress).toMatch(/^bcrt1p/);

  // ── Fund the buyer (Xverse) wallet ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', wallet.paymentAddress, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const walletFundUtxo = await waitForUtxoAt(wallet.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[xverse-create-offer] buyer funded utxo ${walletFundUtxo.txid}:${walletFundUtxo.vout} (${walletFundUtxo.value} sats)`);

  // ── Synthesise seller (raw P2WPKH), fund, pure-SDK mint the cat ──
  const sellerPriv = secp256k1.utils.randomPrivateKey();
  const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
  const sellerP2 = btc.p2wpkh(sellerPub, regtestNetwork);
  const sellerAddress = sellerP2.address!;
  const sellerScript = sellerP2.script;

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', sellerAddress, String(SELLER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const sellerFundUtxo = await waitForUtxoAt(sellerAddress, Math.round(SELLER_FUND_AMOUNT_BTC * 1e8));

  // Seller mints with a non-cat21wallet walletType → mint sequence
  // 0xfffffffe (what a third-party wallet would produce). The mint's
  // exact sequence isn't the subject of this spec — the offer-acceptance
  // tx is (asserted below at 0xfffffffd).
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
  // Cat lives on the seller's bcrt1q UTXO (vout 0, 546 sats). Poll electrs
  // for it (the per-address history pass lags the confirmed tip).
  const sellerCatUtxo = await waitForUtxoMatching(
    sellerAddress,
    u => u.txid === mintTxid && u.vout === 0,
    `seller cat ${mintTxid}:0`,
  );
  expect(sellerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[xverse-create-offer] seller owns cat ${mintTxid}:0 at ${sellerAddress}`);

  // ── Xverse builds + signs the buyer side of the offer (1 popup) ──
  const createSignKnown = new Set(context.pages());
  const createPromise = harness.evaluate((args) => window.ordpoolSdkHarness.runOperation(args), {
    kind: 'createOffer' as const,
    walletType: 'xverse' as const,
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
  });
  // Xverse (buyer) signs ONLY its funding input at index 1.
  await approveXverseSignPopup(context, createSignKnown, '01-create-offer-sign');
  const created = await createPromise;
  if (created.kind !== 'createOffer') throw new Error('expected createOffer result');

  const buyerSignedPsbtBytes = hexBytes(created.signedPsbtHex);
  // eslint-disable-next-line no-console
  console.log(`[xverse-create-offer] buyer signed input 1; PSBT is ${buyerSignedPsbtBytes.byteLength} bytes`);

  // ── Seller-side validator gate (the gate the wallet's own accept flow
  //     runs before signing) ──
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
  console.log(`[xverse-create-offer] offer-acceptance broadcast txid = ${acceptTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);
  // SegWit txid is witness-independent — neither Xverse (input 1) nor the
  // seller (input 0) mutated non-witness bytes between the unsigned PSBT
  // and broadcast.
  expect(acceptTxid, 'non-witness bytes must survive both signing steps').toBe(created.expectedTxid);
  expect(acceptTx.fee, `offer-accept fee = ${OFFER_FEE_SATS} sats`).toBe(OFFER_FEE_SATS);
  assertEveryInputSequence(acceptTx, OFFER_SEQUENCE, 'createOffer-accept');

  // ── electrs is the authority — the cat's 546-sat output-0 UTXO now
  //     sits at Xverse's buyer-receive (ordinals) address ──
  const buyerCatUtxo = await waitForUtxoMatching(
    wallet.ordinalsAddress,
    u => u.txid === acceptTxid && u.vout === 0,
    `cat ${acceptTxid}:0 at buyer ordinals address`,
  );
  expect(buyerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // The cat left the seller's address (positive proof it moved).
  expect((await getUtxos(sellerAddress)).find(u => u.txid === mintTxid && u.vout === 0)).toBeUndefined();

  // ── Seller actually got paid the agreed price (net of postage) ──
  const payment = (await getUtxos(sellerAddress)).find(u => u.txid === acceptTxid);
  if (!payment) throw new Error('seller payment UTXO not found');
  expect(payment.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[xverse-create-offer] cat now at ${wallet.ordinalsAddress}; seller paid ${payment.value} sats`);

  // ── Parser agrees the acceptance tx is a CAT-21 (lockTime=21 re-mint) ──
  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
