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

/**
 * OKX cat21 TRANSFER roundtrip on regtest — full popup-driven path,
 * asserted through electrs + the parser (this CI shard runs bitcoind +
 * electrs only, NOT cat21-ord).
 *
 * 1. Onboard OKX (`onboardOkx`), connect, derive the regtest bcrt1p
 *    from the wallet's compressed pubkey (same cross-network-keys trick
 *    okx-mint uses).
 * 2. Fund the bcrt1p, mint a cat via OKX (1 sign popup). Cat lands at
 *    output 0 (546 sats); the mint change lands at output 1. Both live
 *    at OKX's single BIP-86 Taproot address (payment === ordinals).
 * 3. Identify the cat UTXO (vout 0) + the mint change UTXO via electrs.
 * 4. Synthesise a raw P2WPKH destination keypair.
 * 5. Build a transfer PSBT via the SDK; OKX signs input 0 (Taproot cat)
 *    and input 1 (Taproot funding) in one signPsbt call (`toSignInputs`
 *    [0, 1] → one popup). Broadcast via local electrs.
 * 6. Assert via electrs: the cat's 546-sat output-0 UTXO now sits at
 *    the destination address; the wire tx carries lockTime=21 across
 *    all inputs under SIGHASH_ALL; the parser still reads it as a
 *    CAT-21 (every cat-touching tx we build re-mints).
 *
 * OKX is address-based, single-address BIP-86 Taproot: the whole cat
 * flow (cat + funding + change) rides one `bcrt1p`, so OKX's signPsbt
 * handles the transfer's inputs (all at OKX-owned addresses). The
 * child-reveal spec is fixmed only for OKX-extension e2e instability,
 * not a signing limit; its operation is proven (both signs complete).
 * See okx-inscribe-child-roundtrip.spec.ts.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const TRANSFER_FEE_SATS = 1500;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;
let onboardPage: Page | null = null;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `okx-transfer-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  // CRITICAL: anchor on the "Connect account" page header (not just any
  // button named Connect/Confirm/Approve) — OKX opens a "Confirm Trade"
  // sign popup pre-emptively during connect. Loose button matching would
  // accept that wrong popup and our signPsbt would land later with no
  // popup to approve. Copied EXACTLY from okx-mint-roundtrip.spec.ts.
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
  // OKX reuses the connect popup's Page for sign — poll every
  // chrome-extension page for the sign-popup heading regardless of when
  // the page was created. Heading varies across OKX versions:
  // "Signature request" (new) vs "Confirm Trade" (legacy) vs an
  // "Asset transfer pending" promo overlay. Copied from
  // okx-mint-roundtrip.spec.ts.
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
      // Diagnostic snapshot of every extension page's URL + first
      // headline text, deduped on a 10s cadence. Helps spot OKX moving
      // the sign approval to a side panel or a new hash route.
      const snippet = (text.split('\n').find(s => s.trim().length > 0) ?? '').slice(0, 80);
      const key = `${p.url()}|${snippet}`;
      if (!seenSnapshots.has(key)) {
        seenSnapshots.add(key);
        console.log(`[okx-transfer:diag] page url=${p.url().slice(0, 100)} first-line="${snippet}"`);
      }
    }
    if (approval) break;
    if (Date.now() - lastLog > 10_000) {
      console.log(`[okx-transfer:diag] waiting for ${tag} sign popup… pages=${ctx.pages().length}`);
      lastLog = Date.now();
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!approval) throw new Error(`OKX ${tag} sign popup never showed Signature request | Confirm Trade within 120s`);
  await shot(approval, `${tag}-sign-approval`);

  // OKX's sign popup may open with an "Asset transfer pending" promo
  // modal layered on top that disables the underlying Confirm button.
  // Dismiss via the modal's X icon if visible, then click Confirm.
  const promoModalText = approval.getByText('Asset transfer pending');
  if (await promoModalText.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const closeBtn = approval.locator('button:has(svg), [aria-label="close" i], [aria-label="Close" i]').first();
    if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await closeBtn.click({ force: true }).catch(() => undefined);
    }
    await promoModalText.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }
  await shot(approval, `${tag}-post-modal-dismiss`);
  // Fallback for the rare case OKX shows an interactive sign popup: wait for
  // Confirm to become actionable, then click. OKX usually auto-signs for the
  // connected dApp, so this is seldom reached.
  await approval.getByText('Confirm', { exact: true }).first().click({ timeout: 60_000 })
    .catch(() => undefined); // close-race: OKX may finish the sign and shut the popup mid-click
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

// OKX signs both the mint and the transfer via signPsbt for the connected
// dApp (both inputs OKX-owned; the SDK shims to OKX's mainnet address).
// Signing resolves without an interactive Confirm on this version. The old
// "Confirm never enables for regtest" note was wrong.
test('transfer a cat21 on regtest via OKX: mint via popup, transfer via popup (toSignInputs [0,1]), broadcast, assert via electrs', async () => {
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
  console.log(`[okx-transfer] mainnet payment = ${wallet.paymentAddress}`);
  // OKX default = BIP-86 Taproot, single-address (payment === ordinals).
  expect(wallet.paymentAddress).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');

  // ── Regtest address + Taproot script for OKX's single address ──
  // OKX exposes a COMPRESSED (33-byte) pubkey on both lanes; the BIP-86
  // internal key is the x-only tail (drop the 02/03 parity prefix).
  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  const okxBcrt1p = regtest.ordinalsAddress;
  expect(okxBcrt1p).toMatch(/^bcrt1p/);
  const ordinalsXOnlyHex = wallet.paymentPublicKey.length === 66
    ? wallet.paymentPublicKey.slice(2)
    : wallet.paymentPublicKey;
  if (ordinalsXOnlyHex.length !== 64) {
    throw new Error(`expected x-only key, got ${ordinalsXOnlyHex.length} hex chars`);
  }
  // Both the cat UTXO and the funding (mint-change) UTXO ride this one
  // Taproot scriptPubKey (single-address contract).
  const okxTaprootScriptHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script);
  console.log(`[okx-transfer] regtest taproot = ${okxBcrt1p}`);

  // ── Fund + mint a cat via OKX (1 sign popup) ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', okxBcrt1p, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(okxBcrt1p, Math.round(FUND_AMOUNT_BTC * 1e8));

  const mintSignedPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'okx' as const,
      utxo: { txid: fundUtxo.txid, vout: fundUtxo.vout, value: fundUtxo.value },
      paymentAddress: okxBcrt1p,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: okxBcrt1p,
      feeSats: MINT_FEE_SATS,
    },
  );
  let mintSignError: Error | null = null;
  mintSignedPromise.catch((e) => { mintSignError = e as Error; });
  try {
    await approveSignPopup(context, '02-mint');
  } catch (popupErr) {
    if (mintSignError) throw new Error(`okx mint signPsbt rejected before popup opened: ${(mintSignError as Error).message}`);
    throw popupErr;
  }
  const minted = await mintSignedPromise;
  if (minted.kind !== 'mint') throw new Error('expected mint result');
  // Clear OKX's leftover popup/notification pages before the next sign.
  await closeLeftoverExtensionPages(context, connectKnownPages);

  const mintTxid = await postTx(minted.txHex);
  console.log(`[okx-transfer] mint broadcast txid = ${mintTxid}`);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  // Third-party-wallet mint RBF policy: sequence is RBF-final so no OKX
  // accelerate flow can drop nLockTime=21 on the unconfirmed mint (the
  // 2024 Xverse-Accelerate incident this suite guards against).
  for (const vin of mintTx.vin) {
    expect((vin as { sequence: number }).sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }
  const mintParsed = Cat21ParserService.parse(mintTx);
  expect(mintParsed).not.toBeNull();
  expect(mintParsed!.type).toBe(DigitalArtifactType.Cat21);

  // ── Identify the cat UTXO (vout 0) + the mint change UTXO ──
  await waitForUtxoMatching(okxBcrt1p, u => u.txid === mintTxid && u.vout === 0, `cat utxo ${mintTxid}:0`);
  const okxUtxos = await getUtxos(okxBcrt1p);
  const catUtxo = okxUtxos.find(u => u.txid === mintTxid && u.vout === 0);
  const changeUtxo = okxUtxos.find(u => u.txid === mintTxid && u.vout !== 0);
  if (!catUtxo) throw new Error('cat UTXO (vout 0) not found at OKX address');
  if (!changeUtxo) throw new Error('mint change UTXO not found at OKX address');
  expect(catUtxo.value).toBe(CAT21_POSTAGE_SATS);
  console.log(`[okx-transfer] cat ${catUtxo.txid}:${catUtxo.vout} | change ${changeUtxo.txid}:${changeUtxo.vout} (${changeUtxo.value} sats)`);

  // ── Synthesise a raw P2WPKH destination keypair (regtest bcrt1q) ──
  const destPriv = secp256k1.utils.randomPrivateKey();
  const destPub = secp256k1.getPublicKey(destPriv, true);
  const destinationAddress = btc.p2wpkh(destPub, regtestNetwork).address!;
  console.log(`[okx-transfer] destination = ${destinationAddress}`);

  // ── TRANSFER via OKX (input 0 cat + input 1 funding, one popup) ──
  // The signing-hint addresses handed to OKX's `toSignInputs` MUST be
  // OKX's MAINNET bc1p: OKX validates each row's address against its own
  // mainnet address set and silently drops the request otherwise. The
  // PSBT-embedded output addresses (recipient / change) and every input
  // scriptPubKey stay regtest — script bytes are HRP-independent, so
  // OKX's mainnet-decoded address matches the regtest script.
  const transferSignedPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'transfer' as const,
      walletType: 'okx' as const,
      catInput: {
        txid: catUtxo.txid,
        vout: catUtxo.vout,
        value: catUtxo.value,
        scriptPubKeyHex: okxTaprootScriptHex,
        tapInternalKeyHex: ordinalsXOnlyHex,
      },
      fundingInputs: [{
        txid: changeUtxo.txid,
        vout: changeUtxo.vout,
        value: changeUtxo.value,
        scriptPubKeyHex: okxTaprootScriptHex,
      }],
      ordinalsAddress: wallet.paymentAddress,
      paymentAddress: wallet.paymentAddress,
      recipientAddress: destinationAddress,
      senderChangeAddress: okxBcrt1p,
      feeSats: TRANSFER_FEE_SATS,
    },
  );
  let transferSignError: Error | null = null;
  transferSignedPromise.catch((e) => { transferSignError = e as Error; });
  try {
    await approveSignPopup(context, '03-transfer');
  } catch (popupErr) {
    if (transferSignError) throw new Error(`okx transfer signPsbt rejected before popup opened: ${(transferSignError as Error).message}`);
    throw popupErr;
  }
  const transferred = await transferSignedPromise;
  if (transferred.kind !== 'transfer') throw new Error('expected transfer result');

  const transferTxid = await postTx(transferred.txHex);
  console.log(`[okx-transfer] transfer broadcast txid = ${transferTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  const transferTx = await waitForTxConfirmed(transferTxid);
  expect(transferTx.locktime).toBe(21);
  expect(transferTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(transferTx);
  // Non-witness bytes survive signing: the on-chain txid equals the txid
  // computed from the unsigned PSBT (SegWit txid is witness-independent).
  expect(transferTxid, 'wallet must not modify non-witness bytes (transfer)').toBe(transferred.expectedTxid);
  // Exact fee: the funding UTXO is large enough that change clears dust,
  // so no sub-dust absorb.
  expect(transferTx.fee, `transfer fee = ${TRANSFER_FEE_SATS} sats`).toBe(TRANSFER_FEE_SATS);
  // No sequence assertion here: the transfer builder pins 0xfffffffd
  // (RBF-on for every wallet on transfers) — not the mint RBF-off policy.

  // ── Assert the cat moved: 546-sat output-0 UTXO at the destination ──
  const catAtDest = await waitForUtxoMatching(
    destinationAddress,
    u => u.txid === transferTxid && u.vout === 0,
    `cat at destination ${transferTxid}:0`,
  );
  expect(catAtDest.value).toBe(CAT21_POSTAGE_SATS);

  const parsed = Cat21ParserService.parse(transferTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(transferTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
  console.log(`[okx-transfer] cat now at ${destinationAddress}`);
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
