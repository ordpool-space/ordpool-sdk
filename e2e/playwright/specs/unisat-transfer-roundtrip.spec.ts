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

/**
 * Unisat CAT-21 TRANSFER roundtrip on regtest — full popup-driven path,
 * asserted through electrs + ordpool-parser (NO ord: the Unisat CI shard
 * runs bitcoind + electrs only).
 *
 * Unisat signs ONLY with its ACTIVE account key and matches inputs by
 * address (Unisat `toSignInputs`). The transfer signs a Taproot cat input
 * at index 0, so Unisat is onboarded in BIP-86 Taproot (P2TR) mode exactly
 * like `unisat-inscribe-child-roundtrip`: the single active account IS the
 * taproot key, and paymentAddress === ordinalsAddress === the bc1p taproot
 * address. Both the cat (input 0) and the funding change (input 1) live at
 * that one taproot address, so the one active key signs the whole transfer.
 *
 * Cross-network-keys trick (same as every mainnet-only wallet): Unisat
 * ships only mainnet/signet/testnet, so we onboard on mainnet, fund the
 * regtest-encoded bcrt1p address derived from the same pubkey, and hand
 * Unisat regtest PSBT bytes to sign. Taproot script bytes are HRP-free, so
 * a signature Unisat makes against its mainnet bc1p account verifies
 * against the equivalent regtest scriptPubKey. Because the harness passes
 * the signer's `ordinalsAddress` / `paymentAddress` through verbatim (no
 * per-op mainnet shim for transfer/offer/accept), the spec hands Unisat its
 * MAINNET bc1p address so its active-account match succeeds; the PSBT
 * itself still carries the bcrt1p bytes.
 *
 * signTransfer is one of the four operations the wallet's popup / MCP
 * surface dispatches. This pins the contract end-to-end: real bitcoind,
 * real electrs, real Unisat binary, real popup approvals.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

// BIP-86 Taproot derivation of `abandon × 11 + about` on mainnet — the
// same value pinned by unisat-matrix.spec.ts's P2TR variant. Unisat's
// active account address in Taproot mode; the value Unisat matches
// `toSignInputs` against.
const UNISAT_MAINNET_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

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

// Onboarding copied from unisat-inscribe-child-roundtrip.spec.ts: Taproot
// (P2TR) address type (card index 2) so the single active account is the
// taproot key. The transfer's cat input (and the funding change) are P2TR
// spends only the active-type key can sign.
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

  // Pick the BIP-86 Taproot address type (card index 2) so Unisat's single
  // active account IS the taproot key. Guarded so a differing card layout
  // doesn't break onboarding — the mainnet-address pin below catches a
  // missed selection.
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
 * `knownPages` so the NEXT call skips it (this flow fires two sequential
 * sign popups: the mint, then the transfer).
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
  await onboardUnisat(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('transfer a cat21 on regtest via Unisat (Taproot mode): mint via popup, transfer via popup, assert via electrs + parser', async () => {
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

  // ── Connect (Taproot mode: single active account = taproot key) ──
  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  // eslint-disable-next-line no-console
  console.log(`[unisat-transfer] mainnet taproot = ${wallet.paymentAddress}`);
  expect(wallet.paymentAddress).toBe(UNISAT_MAINNET_TAPROOT);
  // Single-address wallet: ordinals mirrors payment.
  expect(wallet.ordinalsAddress).toBe(UNISAT_MAINNET_TAPROOT);

  // The mainnet address Unisat matches `toSignInputs` against for the
  // transfer signer path (harness passes signer addresses through
  // verbatim; the PSBT still carries regtest bytes).
  const mainnetTaproot = wallet.paymentAddress;

  // Regtest-encoded equivalents from the same taproot pubkey. In Taproot
  // mode both the payment change and the cat live at the bcrt1p address.
  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  const walletTaproot = regtest.ordinalsAddress;
  expect(walletTaproot).toMatch(/^bcrt1p/);
  const ordinalsXOnlyHex = xOnlyHex(wallet.paymentPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only taproot pubkey').toBe(64);
  const ordinalsXOnly = hexBytes(ordinalsXOnlyHex);
  // The taproot scriptPubKey (BIP-86 tweaked output key) — identical bytes
  // for cat and funding change since both live at the same bcrt1p address.
  const taprootScriptHex = bytesHex(btc.p2tr(ordinalsXOnly, undefined, regtestNetwork).script);

  // ── Fund the wallet's bcrt1p with a single 0.001 BTC UTXO ──
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', walletTaproot, String(FUND_AMOUNT_BTC)).trim();
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(walletTaproot, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[unisat-transfer] funded via ${fundTxid}, using ${fundUtxo.txid}:${fundUtxo.vout} (${fundUtxo.value} sats)`);

  // ── Step 1: MINT via Unisat (1 popup). Taproot funding input; the mint
  // ── path threads the pubkey so the harness shims paymentAddress to the
  // ── wallet's mainnet bc1p for the signer, so the mint keeps regtest addrs ──
  const mintSignKnown = new Set(context.pages());
  const mintSignedPromise = harness.evaluate(
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
  const minted = await mintSignedPromise;
  if (minted.kind !== 'mint') throw new Error('expected mint result');
  const mintTxid = await postTx(minted.txHex);
  // eslint-disable-next-line no-console
  console.log(`[unisat-transfer] mint broadcast txid = ${mintTxid}`);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  expect(mintTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(mintTx);
  // Cat-sat RBF guard on the MINT, mirrored from unisat-mint-roundtrip: a
  // third-party wallet's mint must NOT signal RBF, so a fee-bump flow
  // can't drop nLockTime=21 and kill the cat (2024 Xverse-Accelerate
  // incident). 0xfffffffe = non-RBF, consensus-well-formed.
  for (const vin of mintTx.vin) {
    expect((vin as { sequence: number }).sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }
  const mintParsed = Cat21ParserService.parse(mintTx);
  expect(mintParsed).not.toBeNull();
  expect(mintParsed!.type).toBe(DigitalArtifactType.Cat21);

  // ── Step 2: identify cat UTXO (vout 0) + mint change UTXO. Both at the
  // ── same bcrt1p taproot address in Taproot mode ──
  await waitForUtxoMatching(walletTaproot, u => u.txid === mintTxid && u.vout === 0, `cat utxo ${mintTxid}:0`);
  const ordUtxos = await getUtxos(walletTaproot);
  const catUtxo = ordUtxos.find(u => u.txid === mintTxid && u.vout === 0);
  if (!catUtxo) throw new Error('cat UTXO not found at wallet taproot address');
  expect(catUtxo.value).toBe(CAT21_POSTAGE_SATS);
  const changeUtxo = ordUtxos.find(u => u.txid === mintTxid && u.vout !== 0);
  if (!changeUtxo) throw new Error('mint change UTXO not found at wallet taproot address');
  // eslint-disable-next-line no-console
  console.log(`[unisat-transfer] cat ${catUtxo.txid}:${catUtxo.vout} | change ${changeUtxo.txid}:${changeUtxo.vout} (${changeUtxo.value} sats)`);

  // ── Step 3: synthesise a destination keypair (raw P2WPKH on regtest) ──
  const destPriv = secp256k1.utils.randomPrivateKey();
  const destPub = secp256k1.getPublicKey(destPriv, true);
  const destinationAddress = btc.p2wpkh(destPub, regtestNetwork).address!;
  expect(destinationAddress).toMatch(/^bcrt1q/);
  // eslint-disable-next-line no-console
  console.log(`[unisat-transfer] destination address = ${destinationAddress}`);

  // ── Step 4: TRANSFER via Unisat (ONE sign popup covering both inputs) ──
  // signTransfer topology: input 0 = cat (taproot at ordinalsAddress),
  // input 1 = funding change (taproot at paymentAddress). Both signer-hint
  // addresses are the wallet's MAINNET bc1p so Unisat's active-account
  // match succeeds; destinations (recipient / change) are regtest addresses
  // for the builder, which structures the PSBT with Network.Regtest.
  const transferSignKnown = new Set(context.pages());
  const transferSignedPromise = harness.evaluate(
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
      ordinalsAddress: mainnetTaproot,
      paymentAddress: mainnetTaproot,
      recipientAddress: destinationAddress,
      senderChangeAddress: walletTaproot,
      feeSats: TRANSFER_FEE_SATS,
    },
  );
  await approveSignPopup(context, transferSignKnown, '03-transfer-sign');
  const transferred = await transferSignedPromise;
  if (transferred.kind !== 'transfer') throw new Error('expected transfer result');

  const transferTxid = await postTx(transferred.txHex);
  // eslint-disable-next-line no-console
  console.log(`[unisat-transfer] transfer broadcast txid = ${transferTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const transferTx = await waitForTxConfirmed(transferTxid);
  expect(transferTx.locktime).toBe(21);
  expect(transferTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(transferTx);
  // Non-witness-tamper guard: SegWit txid is witness-independent (BIP-141),
  // so the on-chain txid must equal the txid of the UNSIGNED PSBT. A
  // mismatch means Unisat mutated inputs/outputs/locktime/sequence between
  // unsigned-and-handed-to-popup and broadcast.
  expect(transferTxid, 'Unisat must not modify non-witness bytes (transfer)').toBe(transferred.expectedTxid);
  // Exact fee: the funding UTXO is large enough that change clears dust,
  // so there is no sub-dust absorb into the miner fee.
  expect(transferTx.fee, `transfer fee = ${TRANSFER_FEE_SATS} sats`).toBe(TRANSFER_FEE_SATS);
  // No sequence assertion here: the transfer builder pins 0xfffffffd
  // (RBF-on for every wallet on transfers), NOT the mint RBF-off policy.

  // ── Assert via ELECTRS: the cat's 546-sat UTXO now sits at output 0 of
  // ── the transfer, at the fresh destination address ──
  const movedCat = await waitForUtxoMatching(
    destinationAddress,
    u => u.txid === transferTxid && u.vout === 0,
    `cat at destination ${transferTxid}:0`,
  );
  expect(movedCat.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[unisat-transfer] cat now at ${destinationAddress} (${movedCat.txid}:${movedCat.vout})`);

  // ── Assert via ordpool-parser: the transfer tx is itself a CAT-21 mint
  // ── (lockTime=21 re-mints a cat onto the same ordinal) ──
  const parsed = Cat21ParserService.parse(transferTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(transferTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
