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

/**
 * Leather TRANSFER roundtrip on regtest — proves the real Leather binary
 * signs a CAT-21 transfer end-to-end. Turns the SDK capability matrix's
 * `leather / transfer` adapter cell into `proven`.
 *
 * The Leather CI shard runs ONLY bitcoind + electrs (no cat21-ord), so
 * every "did the cat move" claim is made against electrs + the parser,
 * never ord: a 546-sat output-0 UTXO landing at the destination address
 * IS the cat (ordinal theory — the cat rides the first sat of output 0),
 * plus lockTime=21, SIGHASH_ALL on every input, and Cat21ParserService.
 *
 * Network: Leather ignores its `network` arg in `getAddresses` and hands
 * back mainnet `bc1q…` / `bc1p…`. The signer-side shim
 * (`toWireNetworkFor(leather, Regtest)` → Mainnet) makes Leather sign
 * with its mainnet-derived keys; the Schnorr / ECDSA signatures verify
 * against the regtest PSBT because scriptPubKey bytes are HRP-independent.
 * We derive the regtest addresses inline from the connect-returned
 * pubkeys — the cat lands at Leather's REAL BIP-86 ordinals address
 * (from `ordinalsPublicKey`), so the wallet's own key can sign it back
 * out on the transfer (the mint spec's payment-pubkey-derived taproot
 * trick is mint-only; nothing ever spends that address).
 *
 * Flow:
 *  1. Onboard Leather with the BIP-39 test seed (beforeAll).
 *  2. connectLeather → mainnet bc1q / bc1p + pubkeys.
 *  3. Fund the regtest bcrt1q payment address via bitcoind.
 *  4. Mint a cat via Leather (1 sign popup). Cat lands at the wallet's
 *     bcrt1p ordinals address; change at the bcrt1q payment address.
 *  5. Identify the cat UTXO (vout 0) + the mint change UTXO.
 *  6. Synthesise a destination P2WPKH keypair (raw, regtest).
 *  7. Transfer via Leather — input 0 (Taproot cat) then input 1 (P2WPKH
 *     funding), each signed in its OWN sequential Leather popup.
 *  8. Broadcast via local electrs; mine. Assert the cat's 546-sat
 *     output-0 UTXO is now at the destination, lockTime=21, SIGHASH_ALL,
 *     and the tx re-parses as a CAT-21.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';

const FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const TRANSFER_FEE_SATS = 1500;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `leather-transfer-${name}.png`),
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
 * `knownPages` so the NEXT call skips it. Leather signs one input per
 * popup, so the transfer fires TWO sequential popups (input 0 = Taproot
 * cat, input 1 = P2WPKH funding). Leather's sign surface has no stable
 * testid; match by the visible Confirm/Sign/Approve button's role+name.
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
  await confirmBtn.click();
  knownPages.add(approval);
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

test('transfer a cat21 on regtest via Leather: mint via popup, transfer via two sequential popups, broadcast via local electrs', async () => {
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
  console.log(`[leather-transfer] payment=${paymentAddress} ordinals=${ordinalsAddress}`);

  // ── Fund the wallet's bcrt1q with a single 0.001 BTC UTXO ──
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[leather-transfer] funded via ${fundTxid}, using ${fundUtxo.txid}:${fundUtxo.vout} (${fundUtxo.value} sats)`);

  // ── Step 1: MINT via Leather (1 sign popup) ──
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
  console.log(`[leather-transfer] mint broadcast txid = ${mintTxid}`);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  // Non-witness bytes survived the popup: the on-chain txid equals the
  // txid computed from the UNSIGNED PSBT (SegWit txid is witness-
  // independent). Proves Leather did not drop lockTime=21 before signing.
  expect(mintTxid, 'wallet must not modify non-witness bytes (mint)').toBe(minted.expectedTxid);
  // Cat-sat guard on the MINT input: sequence MUST be RBF-final
  // (>= 0xfffffffe) — Leather's mint RBF-off policy so no wallet
  // accelerate flow can drop the nLockTime=21 marker (2024 Xverse
  // incident). Same assertion as leather-mint-roundtrip.spec.ts.
  for (const vin of mintTx.vin as { sequence: number }[]) {
    expect(vin.sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }

  // ── Step 2: identify the cat UTXO (vout 0) + the mint change UTXO ──
  const catUtxo = (await getUtxos(ordinalsAddress)).find(u => u.txid === mintTxid && u.vout === 0);
  if (!catUtxo) throw new Error('cat UTXO not found at ordinalsAddress');
  expect(catUtxo.value).toBe(CAT21_POSTAGE_SATS);

  const changeUtxo = (await getUtxos(paymentAddress)).find(u => u.txid === mintTxid);
  if (!changeUtxo) throw new Error('mint change UTXO not found at paymentAddress');
  // eslint-disable-next-line no-console
  console.log(`[leather-transfer] cat ${catUtxo.txid}:${catUtxo.vout} | change ${changeUtxo.txid}:${changeUtxo.vout} (${changeUtxo.value} sats)`);

  // ── Step 3: synthesise a destination keypair (raw P2WPKH on regtest) ──
  const destPriv = secp256k1.utils.randomPrivateKey();
  const destPub = secp256k1.getPublicKey(destPriv, true);
  const destinationAddress = btc.p2wpkh(destPub, regtestNetwork).address!;
  // eslint-disable-next-line no-console
  console.log(`[leather-transfer] destination address = ${destinationAddress}`);

  // ── Step 4: scriptPubKey bytes for the cat + funding inputs ──
  // The cat's Taproot scriptPubKey is OP_1 || 0x20 || TWEAKED output key;
  // `p2tr(internalKey, …)` does the BIP-86 tweak. The PSBT's
  // tapInternalKey field carries the UNTWEAKED x-only internal key so
  // Leather can re-derive the tweak when signing input 0.
  const catScriptPubKeyHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script);
  const fundingScriptPubKeyHex = bytesHex(btc.p2wpkh(hexBytes(walletMainnet.paymentPublicKey), regtestNetwork).script);

  // ── Step 5: TRANSFER via Leather (TWO sequential popups) ──
  // Leather signs one input per popup: input 0 (Taproot cat at the
  // ordinals address), then input 1 (P2WPKH funding at the payment
  // address). Both under SIGHASH_ALL.
  const transferSignKnown = new Set(context.pages());
  const transferPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'transfer' as const,
      walletType: 'leather' as const,
      catInput: {
        txid: catUtxo.txid,
        vout: catUtxo.vout,
        value: catUtxo.value,
        scriptPubKeyHex: catScriptPubKeyHex,
        tapInternalKeyHex: ordinalsXOnlyHex,
      },
      fundingInputs: [{
        txid: changeUtxo.txid,
        vout: changeUtxo.vout,
        value: changeUtxo.value,
        scriptPubKeyHex: fundingScriptPubKeyHex,
      }],
      ordinalsAddress,
      paymentAddress,
      recipientAddress: destinationAddress,
      senderChangeAddress: paymentAddress,
      feeSats: TRANSFER_FEE_SATS,
    },
  );
  await approveSignPopup(context, transferSignKnown, '03a-transfer-sign-cat');
  await approveSignPopup(context, transferSignKnown, '03b-transfer-sign-funding');
  const transferred = await transferPromise;
  if (transferred.kind !== 'transfer') throw new Error('expected transfer result');

  const transferTxid = await postTx(transferred.txHex);
  // eslint-disable-next-line no-console
  console.log(`[leather-transfer] transfer broadcast txid = ${transferTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const transferTx = await waitForTxConfirmed(transferTxid);
  expect(transferTx.locktime).toBe(21);
  expect(transferTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(transferTx);
  expect(transferTxid, 'wallet must not modify non-witness bytes (transfer)').toBe(transferred.expectedTxid);

  // ── Step 6: electrs is the authority — the cat's 546-sat output-0
  // UTXO now lives at the destination address (ordinal theory: the cat
  // rides the first sat of output 0). No ord anywhere in this shard. ──
  const movedCat = await waitForUtxoAt(destinationAddress, CAT21_POSTAGE_SATS);
  expect(movedCat.txid).toBe(transferTxid);
  expect(movedCat.vout).toBe(0);
  const destCatUtxo = (await getUtxos(destinationAddress)).find(u => u.txid === transferTxid && u.vout === 0);
  if (!destCatUtxo) throw new Error('cat UTXO not found at destination address');
  expect(destCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // The old cat UTXO at the wallet's ordinals address is gone (spent).
  expect((await getUtxos(ordinalsAddress)).find(u => u.txid === mintTxid && u.vout === 0)).toBeUndefined();

  // Every cat-touching tx we build re-mints (lockTime=21), so the
  // transfer tx itself parses as a CAT-21.
  const parsed = Cat21ParserService.parse(transferTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(transferTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
  // eslint-disable-next-line no-console
  console.log(`[leather-transfer] cat moved to ${destinationAddress} in ${transferTxid}`);
});
