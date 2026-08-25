import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { Network, toScureNetwork } from '../../../src/network';
import { buildCat21BuyOfferPsbt, validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';
import {
  waitForElectrsSync,
  waitForUtxoAt,
  waitForUtxoMatching,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
  getUtxos,
  assertAllInputsSighashAll,
} from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';

/**
 * Unisat ACCEPT-OFFER roundtrip on regtest — Unisat is the SELLER.
 *
 * 1. Onboard Unisat in Taproot (P2TR) mode, connect.
 * 2. Fund Unisat's bcrt1p via bitcoind.
 * 3. Mint a cat via Unisat (1 sign popup). Cat lands at Unisat's bcrt1p.
 * 4. Synthesise a BUYER keypair (raw P2WPKH). Fund it.
 * 5. Buyer (raw-key, off-extension) builds a buy-offer PSBT against
 *    Unisat's cat UTXO via buildCat21BuyOfferPsbt, signs their own
 *    input 1 (P2WPKH, SIGHASH_ALL). Input 0 (cat) stays unsigned.
 * 6. Seller-side validator gate accepts the buyer-pre-signed PSBT.
 * 7. Hand the PSBT to runOperation({kind:'acceptOffer'}). Unisat signs
 *    input 0 (the Taproot cat) via 1 sign popup. Broadcast via electrs.
 * 8. Assert (electrs + parser, NO ord): lockTime=21, SIGHASH_ALL on
 *    every input, the 546-sat cat output-0 UTXO landed at the buyer's
 *    address, Cat21ParserService parses the acceptance tx as a CAT-21.
 *
 * TAPROOT MODE (the load-bearing quirk): the accept flow signs the
 * seller's Taproot cat input (input 0) with the ACTIVE account key, so
 * we onboard on the BIP-86 Taproot address type (card 2) exactly as
 * `unisat-inscribe-child-roundtrip.spec.ts` does — the single active
 * key is the taproot key that owns the cat.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

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
/** Normalise a pubkey hex to x-only (32 bytes): drop the 0x02/0x03 parity byte if present. */
function xOnlyHex(pubHex: string): string {
  const s = pubHex.startsWith('0x') ? pubHex.slice(2) : pubHex;
  return s.length === 66 ? s.slice(2) : s;
}

async function onboardUnisat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('welcome-title')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('import-wallet-button').click();

  await expect(page.getByTestId('create-password-input')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-confirm-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-continue-button').click();

  await expect(page.getByTestId('restore-wallet-type-option-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('restore-wallet-type-option-0').click();

  await expect(page.getByTestId('mnemonic-import-word-0')).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await page.getByTestId(`mnemonic-import-word-${i}`).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await page.getByTestId('mnemonic-import-continue-button').click();

  // BIP-86 Taproot (card 2): the single active account IS the taproot
  // key that owns the cat, so the accept flow signs input 0 with it.
  // Guarded so a differing card layout doesn't break onboarding.
  const taprootCard = page.getByTestId('address-type-card-2');
  if (await taprootCard.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await taprootCard.click();
  }
  const addressTypeContinue = page.getByTestId('address-type-continue-button');
  if (await addressTypeContinue.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await addressTypeContinue.click();
  }

  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (await noticeCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await noticeCheckbox.click();
    const noticeOk = page.getByTestId('notice-ok-button');
    if (await noticeOk.isEnabled({ timeout: 3_000 }).catch(() => false)) {
      await noticeOk.click();
    }
  }

  await expect(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
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

/** Fund an address with a fresh UTXO and return it. */
async function fundAddress(address: string, amountBtc: number): Promise<{ txid: string; vout: number; value: number }> {
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', address, String(amountBtc)).trim();
  await waitForElectrsSync(mineBlocks(1));
  await waitForUtxoAt(address, Math.round(amountBtc * 1e8));
  const utxos = await getUtxos(address);
  const u = utxos.find(x => x.txid === fundTxid);
  if (!u) throw new Error(`funding UTXO ${fundTxid} not found at ${address}`);
  return { txid: u.txid, vout: u.vout, value: u.value };
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
  await onboardUnisat(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('accept a CAT-21 buy offer on regtest via Unisat (seller): mint, buyer builds PSBT, Unisat signs input 0', async () => {
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

  // ── Connect on mainnet Taproot; derive the regtest bcrt1p ──
  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);

  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  // Taproot-active Unisat: single active account = bcrt1p taproot key.
  const paymentAddress = regtest.ordinalsAddress;
  const ordinalsAddress = regtest.ordinalsAddress;
  expect(paymentAddress).toMatch(/^bcrt1p/);
  expect(ordinalsAddress).toMatch(/^bcrt1p/);
  const ordinalsXOnlyHex = xOnlyHex(wallet.paymentPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only taproot pubkey').toBe(64);

  // ── Fund Unisat (seller) + mint a cat via Unisat (1 sign popup) ──
  const fundUtxo = await fundAddress(paymentAddress, FUND_AMOUNT_BTC);
  const mintSignKnown = new Set(context.pages());
  const mintPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'unisat' as const,
      utxo: fundUtxo,
      paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: ordinalsAddress,
      feeSats: MINT_FEE_SATS,
    },
  );
  await approveSignPopup(context, mintSignKnown, '02-mint-sign');
  const minted = await mintPromise;
  if (minted.kind !== 'mint') throw new Error('expected mint result');
  const mintTxid = await postTx(minted.txHex);
  expect(mintTxid, 'wallet must not modify non-witness bytes (mint)').toBe(minted.expectedTxid);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  // Cat-sat guard (mint policy), same as `unisat-mint-roundtrip.spec.ts`.
  for (const vin of mintTx.vin) {
    expect((vin as { sequence: number }).sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }
  const sellerCatUtxo = await waitForUtxoMatching(
    ordinalsAddress,
    u => u.txid === mintTxid && u.vout === 0 && u.value === CAT21_POSTAGE_SATS,
    `seller cat ${mintTxid}:0 (546 sats) at ${ordinalsAddress}`,
  );
  expect(sellerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);

  // ── Synthesise buyer (raw P2WPKH), fund it ──
  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyerPub = secp256k1.getPublicKey(buyerPriv, true);
  const buyerP2 = btc.p2wpkh(buyerPub, regtestNetwork);
  const buyerAddress = buyerP2.address!;
  const buyerScript = buyerP2.script;
  const buyerFundUtxo = await fundAddress(buyerAddress, BUYER_FUND_AMOUNT_BTC);

  // ── Buyer builds the offer PSBT against Unisat's cat ──
  // Seller's cat UTXO is Taproot; scriptPubKey = OP_1 || 0x20 || TWEAKED
  // output key (BIP-86). `p2tr(internalKey, …)` performs the tweak.
  const sellerCatScript = btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script;
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

  // Seller-side validator gate accepts the buyer-pre-signed PSBT.
  const validation = validateCat21BuyOfferPsbt({
    psbt: buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: paymentAddress,
    network: Network.Regtest,
  });
  expect(validation.ok).toBe(true);

  // ── Unisat (seller) signs input 0 — the Taproot cat (1 sign popup) ──
  const acceptSignKnown = new Set(context.pages());
  const acceptPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'acceptOffer' as const,
      walletType: 'unisat' as const,
      psbtHex: bytesHex(buyerSignedPsbtBytes),
      ordinalsAddress,
    },
  );
  await approveSignPopup(context, acceptSignKnown, '03-accept-sign');
  const accepted = await acceptPromise;
  if (accepted.kind !== 'acceptOffer') throw new Error('expected acceptOffer result');

  const acceptTxid = await postTx(accepted.txHex);
  expect(acceptTxid, 'wallet must not modify non-witness bytes (acceptOffer)').toBe(accepted.expectedTxid);
  await waitForElectrsSync(mineBlocks(1));
  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);

  // ── electrs proves the cat is now at the buyer's address ──
  const movedCat = await waitForUtxoMatching(
    buyerAddress,
    u => u.txid === acceptTxid && u.vout === 0 && u.value === CAT21_POSTAGE_SATS,
    `cat ${acceptTxid}:0 (546 sats) at ${buyerAddress}`,
  );
  expect(movedCat.value).toBe(CAT21_POSTAGE_SATS);

  // Seller was paid priceSats + postage (ord-parity).
  const sellerUtxosAfter = await getUtxos(paymentAddress);
  const payment = sellerUtxosAfter.find(u => u.txid === acceptTxid && u.vout === 1);
  expect(payment).toBeTruthy();
  expect(payment!.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);

  // Parser confirms the acceptance tx is itself a CAT-21.
  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
