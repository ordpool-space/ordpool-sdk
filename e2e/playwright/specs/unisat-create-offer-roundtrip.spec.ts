import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { Network, toScureNetwork } from '../../../src/network';
import { buildCat21MintPsbt } from '../../../src/cat21-mint/cat21-mint.helper';
import { validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
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
 * Unisat CREATE-OFFER roundtrip on regtest — Unisat is the BUYER.
 *
 * 1. Onboard Unisat in Taproot (P2TR) mode, connect.
 * 2. Fund Unisat's bcrt1p via bitcoind.
 * 3. Synthesise a SELLER keypair (raw P2WPKH). Fund it, pure-SDK mint a
 *    cat at the seller (raw-key signs input 0). Cat lives on the
 *    seller's bcrt1q UTXO.
 * 4. Unisat builds a buy-offer PSBT against the seller's cat with its
 *    own funding UTXO at input 1, and signs input 1 (P2TR key-path,
 *    1 sign popup) via runOperation({kind:'createOffer'}); input 0 (the
 *    seller's cat) stays UNSIGNED per the buyer-initiated PSBT contract.
 * 5. Seller-side validator gate accepts the buyer-pre-signed PSBT.
 * 6. Seller (raw key) signs input 0 SIGHASH_ALL, finalize, broadcast.
 * 7. Assert (electrs + parser, NO ord): lockTime=21, SIGHASH_ALL on
 *    every input, the 546-sat cat output-0 UTXO landed at Unisat's
 *    buyer-receive address, the seller was paid, Cat21ParserService
 *    parses the acceptance tx as a CAT-21.
 *
 * TAPROOT MODE: Unisat signs only with the ACTIVE account key, so we
 * onboard on the BIP-86 Taproot address type (card 2) exactly as
 * `unisat-inscribe-child-roundtrip.spec.ts` does. The buyer funding
 * input at input 1 therefore lives at the active bcrt1p taproot address.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

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
  // key, so the buyer funding input at input 1 lives at it. Guarded so a
  // differing card layout doesn't break onboarding.
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

test('build + sign a CAT-21 buy-offer on regtest via Unisat (buyer): seller raw-key mints, Unisat signs buyer input 1, seller signs input 0', async () => {
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
  // Buyer funds from, receives the cat at, and takes change back to that
  // one address.
  const buyerAddress = regtest.ordinalsAddress;
  expect(buyerAddress).toMatch(/^bcrt1p/);
  const buyerXOnlyHex = xOnlyHex(wallet.paymentPublicKey);
  expect(buyerXOnlyHex.length, 'x-only taproot pubkey').toBe(64);
  const buyerScriptHex = bytesHex(btc.p2tr(hexBytes(buyerXOnlyHex), undefined, regtestNetwork).script);

  // ── Fund Unisat (buyer) ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', buyerAddress, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const buyerFundUtxo = await waitForUtxoAt(buyerAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ── Synthesise seller (raw P2WPKH), fund, pure-SDK mint ──
  const sellerPriv = secp256k1.utils.randomPrivateKey();
  const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
  const sellerP2 = btc.p2wpkh(sellerPub, regtestNetwork);
  const sellerAddress = sellerP2.address!;
  const sellerScript = sellerP2.script;

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', sellerAddress, String(SELLER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
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
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(mintTxid);
  // Seller now owns the cat: 546-sat output-0 UTXO at the seller address.
  const sellerCatUtxo = await waitForUtxoMatching(
    sellerAddress,
    u => u.txid === mintTxid && u.vout === 0 && u.value === CAT21_POSTAGE_SATS,
    `seller cat ${mintTxid}:0 (546 sats) at ${sellerAddress}`,
  );
  expect(sellerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);

  // ── Unisat (buyer) builds + signs its funding input 1 (1 sign popup) ──
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
        txid: buyerFundUtxo.txid,
        vout: buyerFundUtxo.vout,
        value: buyerFundUtxo.value,
        scriptPubKeyHex: buyerScriptHex,
      }],
      paymentAddress: buyerAddress,
      buyerReceiveAddress: buyerAddress,
      sellerPaymentAddress: sellerAddress,
      buyerChangeAddress: buyerAddress,
      priceSats: PRICE_SATS,
      feeSats: OFFER_FEE_SATS,
    },
  );
  await approveSignPopup(context, createSignKnown, '02-create-offer-sign');
  const created = await createPromise;
  if (created.kind !== 'createOffer') throw new Error('expected createOffer result');

  const buyerSignedPsbtBytes = hexBytes(created.signedPsbtHex);

  // ── Seller-side validator gate (the gate the seller's accept flow runs) ──
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
  expect(acceptTxid, 'non-witness bytes must survive both signing steps (createOffer flow)')
    .toBe(created.expectedTxid);

  await waitForElectrsSync(mineBlocks(1));
  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);

  // ── electrs proves the cat is now at Unisat's buyer-receive address ──
  const boughtCat = await waitForUtxoMatching(
    buyerAddress,
    u => u.txid === acceptTxid && u.vout === 0 && u.value === CAT21_POSTAGE_SATS,
    `cat ${acceptTxid}:0 (546 sats) at ${buyerAddress}`,
  );
  expect(boughtCat.value).toBe(CAT21_POSTAGE_SATS);

  // Seller actually got paid the agreed price (net of postage): the
  // seller-payment output value is priceSats + postage (ord-parity).
  const sellerUtxosAfter = await getUtxos(sellerAddress);
  const payment = sellerUtxosAfter.find(u => u.txid === acceptTxid);
  expect(payment).toBeTruthy();
  expect(payment!.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);

  // Parser confirms the acceptance tx is itself a CAT-21 (lockTime=21
  // re-mints onto the same ordinal at output 0).
  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
