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

/**
 * Xverse TRANSFER roundtrip on regtest — proof the real Xverse binary
 * signs a CAT-21 transfer end-to-end.
 *
 * The Xverse CI shard runs ONLY bitcoind + electrs (NOT cat21-ord), so
 * every "did the cat move" assertion goes through electrs + the parser,
 * never ord:
 *   - the cat's 546-sat output-0 UTXO now sits at the destination
 *     address (electrs `getUtxos`),
 *   - the wire tx carries `lockTime=21` (electrs),
 *   - every input commits SIGHASH_ALL (electrs witness bytes),
 *   - `Cat21ParserService.parse` recognises the tx as a CAT-21 (every
 *     cat-touching tx we build re-mints; a transfer is structurally a
 *     mint with `lockTime=21`).
 *
 * Flow:
 *   1. Unlock the seeded (regtest) Xverse wallet, connect via the SDK
 *      harness → native bcrt1q payment + bcrt1p ordinals addresses.
 *   2. Fund the payment address via bitcoind, mine, wait for electrs.
 *   3. Mint a cat via Xverse (1 sign popup). Cat lands at the wallet's
 *      bcrt1p ordinals address; change at the bcrt1q payment address.
 *   4. Identify the cat UTXO (vout 0) + the mint change UTXO.
 *   5. Synthesise a destination P2WPKH keypair (raw, off-wallet).
 *   6. Build the transfer PSBT via the SDK; Xverse signs input 0 (the
 *      Taproot cat) + input 1 (the P2WPKH funding) in ONE legacy
 *      `signTransaction` popup. The harness captures the finalized wire
 *      tx; the spec broadcasts via local electrs.
 *   7. Assert the cat's 546-sat output now sits at the destination
 *      address + lockTime=21 + SIGHASH_ALL + parse.
 *
 * signTransfer is one of the four cat-flow operations Xverse's adapter
 * dispatches; the adapter unit tests pin it against a mocked
 * `signTransaction`, this spec pins the contract against the real
 * binary + a real chain.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const TEST_PASSWORD = 'TestPassword123!';
const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../../test-results/xverse-seed-user-data-dir');

const FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const TRANSFER_FEE_SATS = 1500;
const CAT21_POSTAGE_SATS = 546;

// Mint inputs from any third-party wallet carry the RBF-off sequence
// (`CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE`) — the 2024 Xverse-Accelerate
// mint-RBF defence: no accelerate UI may fire on an unconfirmed mint and
// drop the `nLockTime=21` marker.
const MINT_SEQUENCE = 0xfffffffe;
// Transfer + offer builders use `CAT21_WALLET_INPUT_SEQUENCE` (RBF-on)
// for EVERY wallet — the cat is already on chain, so a marker-less RBF
// replacement only loses a bonus mint, never the cat. See
// `src/cat21-protocol/cat21-sequence.ts` + `cat21-transfer.helper.ts`.
const TRANSFER_SEQUENCE = 0xfffffffd;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: path.resolve(RESULTS_DIR, `xverse-transfer-${name}.png`), fullPage: true }).catch(() => undefined);
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

/**
 * Assert every non-coinbase input's nSequence equals `expected`. The
 * Esplora vin shape doesn't declare `sequence` in the regtest-helpers
 * TypeScript interface, but electrs always includes it in the JSON —
 * narrow via cast. A drift here would silently break the RBF policy the
 * cat-flow depends on.
 */
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
 * close (the close signals the sign completed). Registers the popup in
 * `knownPages` so a subsequent call catches the NEXT one. Copied from
 * `xverse-inscribe-child-roundtrip.spec.ts`: every cat-flow operation
 * (mint, transfer) drives Xverse's legacy `signTransaction` popup, whose
 * head reads "Review transaction" (older) or "Sign transaction" / "Sign
 * PSBT" (newer) — match any of them.
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

  const workingDir = `${SEED_USER_DATA_DIR}.transferspec-${process.pid}-${Date.now()}`;
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

test('transfer a cat21 on regtest via Xverse: mint via popup, transfer via popup, broadcast + verify via electrs/parser', async () => {
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
  // Xverse leaves the connect tab open; closing it forces a fresh tab
  // for the sign step so `waitForApprovalPopup` reliably catches it.
  await approvalConnect.close().catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log(`[xverse-transfer] payment=${wallet.paymentAddress} ordinals=${wallet.ordinalsAddress}`);
  expect(wallet.paymentAddress).toMatch(/^bcrt1q/);
  expect(wallet.ordinalsAddress).toMatch(/^bcrt1p/);

  // ── Fund the payment address ──
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', wallet.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(wallet.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[xverse-transfer] funded via ${fundTxid}, using ${fundUtxo.txid}:${fundUtxo.vout} (${fundUtxo.value} sats)`);

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
  // SegWit txid is witness-independent (BIP-141); SIGHASH_ALL commits to
  // the non-witness bytes. A mismatch means Xverse tampered with
  // inputs/outputs/locktime/sequence between unsigned and broadcast.
  expect(mintTxid, 'wallet must not modify non-witness bytes (mint)').toBe(minted.expectedTxid);
  // Mint inputs are RBF-off (>= 0xfffffffe). Match the proven
  // xverse-mint-roundtrip assertion style (`>=`, not exact).
  mintTx.vin.forEach((raw, i) => {
    const v = raw as { sequence?: number; is_coinbase?: boolean };
    if (v.is_coinbase) return;
    expect(v.sequence, `mint vin[${i}].sequence`).toBeGreaterThanOrEqual(MINT_SEQUENCE);
  });

  // ── Step 2: identify the cat UTXO (vout 0) + change UTXO ──
  // Poll electrs for the cat UTXO (the address-history pass lags the tip
  // even after waitForTxConfirmed). Once it's indexed, the change UTXO on
  // the sibling address is reliably visible in the same electrs.
  const catUtxo = await waitForUtxoMatching(
    wallet.ordinalsAddress,
    u => u.txid === mintTxid && u.vout === 0,
    `cat ${mintTxid}:0 at ordinalsAddress`,
  );
  expect(catUtxo.value).toBe(CAT21_POSTAGE_SATS);

  const payUtxos = await getUtxos(wallet.paymentAddress);
  const changeUtxo = payUtxos.find(u => u.txid === mintTxid);
  if (!changeUtxo) throw new Error('mint change UTXO not found at paymentAddress');
  // eslint-disable-next-line no-console
  console.log(`[xverse-transfer] cat ${catUtxo.txid}:${catUtxo.vout} | change ${changeUtxo.txid}:${changeUtxo.vout} (${changeUtxo.value} sats)`);

  // ── Step 3: synthesise a destination keypair (raw P2WPKH on regtest) ──
  const destPriv = secp256k1.utils.randomPrivateKey();
  const destPub = secp256k1.getPublicKey(destPriv, true);
  const destinationAddress = btc.p2wpkh(destPub, regtestNetwork).address!;
  // eslint-disable-next-line no-console
  console.log(`[xverse-transfer] destination address = ${destinationAddress}`);

  // ── Step 4: scriptPubKey + tapInternalKey for the cat input ──
  // The Taproot scriptPubKey is OP_1 || 0x20 || TWEAKED output key
  // (BIP-86); `p2tr(internalKey, …)` performs the tweak. The PSBT's
  // `tapInternalKey` carries the UNTWEAKED x-only internal key.
  const ordinalsXOnlyHex = xOnlyHex(wallet.ordinalsPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only ordinals pubkey').toBe(64);
  const catScriptPubKeyHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script);
  const fundingScriptPubKeyHex = bytesHex(btc.p2wpkh(hexBytes(wallet.paymentPublicKey), regtestNetwork).script);

  // ── Step 5: TRANSFER via Xverse (1 sign popup, both inputs) ──
  const transferSignKnown = new Set(context.pages());
  const transferPromise = harness.evaluate((args) => window.ordpoolSdkHarness.runOperation(args), {
    kind: 'transfer' as const,
    walletType: 'xverse' as const,
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
    ordinalsAddress: wallet.ordinalsAddress,
    paymentAddress: wallet.paymentAddress,
    recipientAddress: destinationAddress,
    senderChangeAddress: wallet.paymentAddress,
    feeSats: TRANSFER_FEE_SATS,
  });
  await approveXverseSignPopup(context, transferSignKnown, '02-transfer-sign');
  const transferred = await transferPromise;
  if (transferred.kind !== 'transfer') throw new Error('expected transfer result');

  const transferTxid = await postTx(transferred.txHex);
  // eslint-disable-next-line no-console
  console.log(`[xverse-transfer] transfer broadcast txid = ${transferTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const transferTx = await waitForTxConfirmed(transferTxid);
  expect(transferTx.locktime).toBe(21);
  expect(transferTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(transferTx);
  expect(transferTxid, 'wallet must not modify non-witness bytes (transfer)').toBe(transferred.expectedTxid);
  expect(transferTx.fee, `transfer fee = ${TRANSFER_FEE_SATS} sats`).toBe(TRANSFER_FEE_SATS);
  assertEveryInputSequence(transferTx, TRANSFER_SEQUENCE, 'transfer');

  // ── Step 6: electrs is the authority — the cat's 546-sat output-0
  //     UTXO now sits at the destination address (ord not available in
  //     the Xverse CI shard). Output 0 is the cat per FIFO. ──
  const movedCat = await waitForUtxoMatching(
    destinationAddress,
    u => u.txid === transferTxid && u.vout === 0,
    `cat ${transferTxid}:0 at destination`,
  );
  expect(movedCat.value).toBe(CAT21_POSTAGE_SATS);
  // The cat left the wallet's ordinals address (positive proof it moved).
  const ordUtxosAfter = await getUtxos(wallet.ordinalsAddress);
  expect(ordUtxosAfter.find(u => u.txid === catUtxo.txid && u.vout === 0)).toBeUndefined();
  // eslint-disable-next-line no-console
  console.log(`[xverse-transfer] cat now at ${destinationAddress} (${movedCat.txid}:${movedCat.vout})`);

  // ── Parser agrees the transfer tx is a CAT-21 (lockTime=21 re-mint) ──
  const parsed = Cat21ParserService.parse(transferTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(transferTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
