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
  getUtxos,
  assertAllInputsSighashAll,
} from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';

/**
 * Unisat CAT-21 TRANSFER roundtrip on regtest — the real Unisat binary
 * signs a cat transfer end-to-end. Assertions read from electrs + the
 * parser; there is NO ord in the Unisat CI shard (bitcoind + electrs
 * only), so ownership is proven by the on-chain 546-sat output-0 UTXO
 * landing at the destination address.
 *
 * TAPROOT MODE (the load-bearing quirk): Unisat is address-based and
 * signs only with the ACTIVE account key. The transfer signs a Taproot
 * cat input (input 0) AND a funding input (input 1), both living at the
 * wallet's single active address. So we onboard on the BIP-86 Taproot
 * (P2TR) address type exactly as `unisat-inscribe-child-roundtrip.spec.ts`
 * does: the one active key is the taproot key, and
 * paymentAddress === ordinalsAddress === the bcrt1p taproot address.
 * Mint funds from, cat lands on, and the change returns to that same
 * bcrt1p — so the one active key signs the cat input and the funding
 * input in a single sign popup.
 *
 * Network-agnostic-keys trick (same as the mint roundtrip): Unisat ships
 * only mainnet/signet/testnet, so we onboard on mainnet, fund the
 * regtest-encoded address derived from the same pubkey, and hand Unisat
 * the regtest-encoded PSBT (script bytes are HRP-free). We broadcast via
 * local electrs, skipping Unisat's vendor-backend pushPsbt.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const TRANSFER_FEE_SATS = 1500;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `unisat-transfer-${name}.png`),
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

  // Pick the BIP-86 Taproot address type (card index 2) so Unisat's
  // single active account IS the taproot key. The transfer signs a P2TR
  // cat input (input 0) + a P2TR funding input (input 1), both at that
  // key. Guarded so a differing card layout doesn't break onboarding.
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
  // Unisat uses a styled div, not a <button> — match by text.
  await approval.getByText(/^Connect$/).first().click();
}

/**
 * Wait for a Unisat sign popup, approve it, and register it in
 * `knownPages`. Each cat operation (mint, then transfer) fires ONE
 * sign popup; capturing a fresh `knownPages` before each op lets the
 * next call find the next popup.
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

/** Fund an address with a fresh UTXO and return it. */
async function fundAddress(address: string): Promise<{ txid: string; vout: number; value: number }> {
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', address, String(FUND_AMOUNT_BTC)).trim();
  await waitForElectrsSync(mineBlocks(1));
  await waitForUtxoAt(address, Math.round(FUND_AMOUNT_BTC * 1e8));
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

// Unisat (Taproot mode) signs both the Taproot cat input and the
// Taproot funding input in ONE sign popup. The cat lands at the raw
// P2WPKH destination; electrs proves ownership via the 546-sat output-0
// UTXO, and the parser confirms the transfer tx is itself a CAT-21
// (lockTime=21 re-mints onto the same ordinal).
test('transfer a cat21 on regtest via Unisat: mint via popup, transfer via popup, broadcast via electrs', async () => {
  test.setTimeout(600_000);

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

  // Taproot-active Unisat: the single active account is the BIP-86
  // taproot key. Fund from, land the cat on, and route change back to
  // that one bcrt1p address, so the one active key signs the cat input
  // AND the funding input.
  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  const paymentAddress = regtest.ordinalsAddress;
  const ordinalsAddress = regtest.ordinalsAddress;
  expect(paymentAddress).toMatch(/^bcrt1p/);
  expect(ordinalsAddress).toMatch(/^bcrt1p/);
  const ordinalsXOnlyHex = xOnlyHex(wallet.paymentPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only taproot pubkey').toBe(64);
  // Taproot scriptPubKey = OP_1 || 0x20 || TWEAKED output key (BIP-86).
  // `p2tr(internalKey, …)` performs the tweak. The cat AND the funding
  // input both live at this same taproot address.
  const taprootScriptHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, toScureNetwork(Network.Regtest)).script);

  // ── Step 1: MINT a cat via Unisat (1 sign popup) ──
  const fundUtxo = await fundAddress(paymentAddress);
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
  expect(mintTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(mintTx);
  // Cat-sat guard (mint policy): every input's sequence is >= 0xfffffffe
  // (RBF-final) so no third-party accelerate UI can drop nLockTime=21 on
  // an RBF replacement and kill the mint. Same guard as
  // `unisat-mint-roundtrip.spec.ts`.
  for (const vin of mintTx.vin) {
    expect((vin as { sequence: number }).sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }
  const mintParsed = Cat21ParserService.parse(mintTx);
  expect(mintParsed).not.toBeNull();
  expect(mintParsed!.type).toBe(DigitalArtifactType.Cat21);

  // ── Step 2: identify the cat UTXO (vout 0) + change UTXO (vout 1) ──
  // waitForUtxoMatching gates on the per-address index catching up (it
  // lags the per-tx confirmation index by a few hundred ms); once the
  // cat UTXO is visible, the change UTXO (same tx, same address) is too.
  const catUtxo = await waitForUtxoMatching(
    ordinalsAddress,
    u => u.txid === mintTxid && u.vout === 0 && u.value === CAT21_POSTAGE_SATS,
    `cat ${mintTxid}:0 (546 sats) at ${ordinalsAddress}`,
  );
  const ordUtxos = await getUtxos(ordinalsAddress);
  const changeUtxo = ordUtxos.find(u => u.txid === mintTxid && u.vout === 1);
  if (!changeUtxo) throw new Error('mint change UTXO not found at ordinalsAddress');

  // ── Step 3: synthesise a destination keypair (raw P2WPKH on regtest) ──
  const destPriv = secp256k1.utils.randomPrivateKey();
  const destPub = secp256k1.getPublicKey(destPriv, true);
  const destinationAddress = btc.p2wpkh(destPub, toScureNetwork(Network.Regtest)).address!;
  expect(destinationAddress).toMatch(/^bcrt1q/);

  // ── Step 4: TRANSFER via Unisat (1 sign popup covering both inputs) ──
  const transferSignKnown = new Set(context.pages());
  const transferPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'transfer' as const,
      walletType: 'unisat' as const,
      catInput: {
        txid: catUtxo.txid,
        vout: catUtxo.vout,
        value: catUtxo.value,
        scriptPubKeyHex: taprootScriptHex,
        tapInternalKeyHex: ordinalsXOnlyHex,
      },
      fundingInputs: [{
        txid: changeUtxo.txid,
        vout: changeUtxo.vout,
        value: changeUtxo.value,
        scriptPubKeyHex: taprootScriptHex,
      }],
      ordinalsAddress,
      paymentAddress,
      recipientAddress: destinationAddress,
      senderChangeAddress: paymentAddress,
      feeSats: TRANSFER_FEE_SATS,
    },
  );
  await approveSignPopup(context, transferSignKnown, '03-transfer-sign');
  const transferred = await transferPromise;
  if (transferred.kind !== 'transfer') throw new Error('expected transfer result');

  const transferTxid = await postTx(transferred.txHex);
  expect(transferTxid, 'wallet must not modify non-witness bytes (transfer)').toBe(transferred.expectedTxid);
  await waitForElectrsSync(mineBlocks(1));
  const transferTx = await waitForTxConfirmed(transferTxid);
  expect(transferTx.locktime).toBe(21);
  expect(transferTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(transferTx);

  // ── Step 5: electrs proves the cat is now at the destination ──
  // The cat travels on the first sat of output 0 (FIFO). Its landing as
  // a fresh 546-sat UTXO at the destination address is the on-chain
  // proof of ownership transfer — no ord needed.
  const movedCat = await waitForUtxoMatching(
    destinationAddress,
    u => u.txid === transferTxid && u.vout === 0 && u.value === CAT21_POSTAGE_SATS,
    `cat ${transferTxid}:0 (546 sats) at ${destinationAddress}`,
  );
  expect(movedCat.value).toBe(CAT21_POSTAGE_SATS);

  // Parser confirms the transfer tx is itself a CAT-21 (lockTime=21
  // re-mints a fresh cat onto the same ordinal in the same tx).
  const parsed = Cat21ParserService.parse(transferTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(transferTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
