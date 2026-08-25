import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

import * as btc from '@scure/btc-signer';

import { InscriptionParserService } from 'ordpool-parser';

import { Network, toScureNetwork } from '../../../src/network';
import {
  waitForElectrsSync,
  waitForUtxoAt,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
  getUtxos,
} from '../../regtest/regtest-helpers';
import { waitForApprovalPopup } from '../approval-popup';

/**
 * Xverse PARENT/CHILD inscribe roundtrip on regtest — proof that the real
 * Xverse binary signs the child reveal's Taproot parent input alongside a
 * second (foreign, ephemeral-commit) input. Xverse signs via sats-connect,
 * which is purpose-built for multi-input ordinals PSBTs, and is natively
 * regtest-aware (returns real bcrt1q payment + bcrt1p ordinals addresses).
 * Multi-address like Leather: commit funds from the segwit payment address,
 * the parent lives on the Taproot ordinals address.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const TEST_PASSWORD = 'TestPassword123!';
const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../../test-results/xverse-seed-user-data-dir');

const FUND_AMOUNT_BTC = 0.001;
const CAT21_POSTAGE_SATS = 546;
const PARENT_BODY_TEXT = 'xverse PARENT collection root';
const CHILD_BODY_TEXT = 'xverse CHILD of the collection';
const CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: path.resolve(RESULTS_DIR, `xverse-inscribe-child-${name}.png`), fullPage: true }).catch(() => undefined);
}
function utf8ToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
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
 * Approve one Xverse "Review transaction" sign popup and wait for it to
 * close (the close signals the sign completed). Registers the popup in
 * `knownPages` so a subsequent call catches the NEXT one (the child fires
 * two sequential popups: commit funding, then the reveal parent input).
 */
async function approveXverseSignPopup(ctx: BrowserContext, knownPages: Set<Page>, tag: string): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 120_000,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      // The legacy signTransaction popup reads "Review transaction"; the
      // modern signPsbt popup may head with "Sign transaction" / "Sign
      // PSBT" / "Confirm transaction". Match any of them.
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
  // Click the confirm/sign button; the popup closing signals the sign
  // completed. Retry a few times — Xverse's button sometimes needs a
  // second dispatch.
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

async function fundPaymentAddress(paymentAddress: string): Promise<{ txid: string; vout: number; value: number }> {
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  await waitForElectrsSync(mineBlocks(1));
  await waitForUtxoAt(paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  const utxos = await getUtxos(paymentAddress);
  const u = utxos.find(x => x.txid === fundTxid);
  if (!u) throw new Error(`funding UTXO ${fundTxid} not found at ${paymentAddress}`);
  return { txid: u.txid, vout: u.vout, value: u.value };
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

  const workingDir = `${SEED_USER_DATA_DIR}.inscribechildspec-${process.pid}-${Date.now()}`;
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

// Xverse signs the two-input child reveal via modern sats-connect
// `signPsbt` with `signInputs` scoped to the ordinals address: the wallet
// signs ONLY input 0 (its parent P2TR UTXO) and leaves the foreign
// ephemeral-commit input 1 alone — the marketplace multi-input pattern.
// The wallet is handed the BARE reveal PSBT (input 1 stripped of its
// envelope tap-leaf), returns input 0's key-path signature, and the SDK
// merges it into the full reveal PSBT and broadcasts. The legacy
// `signTransaction` path stalls on the foreign input, so the Xverse
// signer overrides `signChildRevealParentInputs` onto modern `signPsbt`
// (`xverse.signer.ts`). Xverse's regtest key (coin_type=1) is loaded
// because the seed dir is regtest-active, so `signPsbt` (no per-request
// network) targets regtest.
test('inscribe a parent then a child via Xverse: wallet signs the Taproot reveal parent input, parent returns to the wallet, child links to it', async () => {
  test.setTimeout(600_000);

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

  // ── Connect ──
  const harness = await context.newPage();
  // eslint-disable-next-line no-console
  harness.on('console', (m) => console.log(`[H] ${m.text()}`));
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(() => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true, { timeout: 15_000 });

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
  expect(wallet.paymentAddress).toMatch(/^bcrt1q/);
  expect(wallet.ordinalsAddress).toMatch(/^bcrt1p/);

  const regtestNetwork = toScureNetwork(Network.Regtest);
  const ordinalsAddress = wallet.ordinalsAddress;
  const paymentAddress = wallet.paymentAddress;
  const ordinalsXOnlyHex = xOnlyHex(wallet.ordinalsPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only ordinals pubkey').toBe(64);
  const parentScriptPubKeyHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script);

  // ── Step 1: inscribe the PARENT at the ordinals address (1 popup) ──
  const parentFunding = await fundPaymentAddress(paymentAddress);
  const parentSignKnown = new Set(context.pages());
  const parentPromise = harness.evaluate((args) => window.ordpoolSdkHarness.runOperation(args), {
    kind: 'inscribe' as const,
    walletType: 'xverse' as const,
    utxo: parentFunding,
    paymentAddress,
    paymentPublicKey: wallet.paymentPublicKey,
    recipientAddress: ordinalsAddress,
    bodyHex: utf8ToHex(PARENT_BODY_TEXT),
    contentType: CONTENT_TYPE,
    feeRatePerVbyte: 5,
  });
  await approveXverseSignPopup(context, parentSignKnown, '01-parent-commit-sign');
  const parent = await parentPromise;
  if (parent.kind !== 'inscribe') throw new Error('expected inscribe result for parent');

  const parentCommitTxid = await postTx(parent.commitHex);
  expect(parentCommitTxid).toBe(parent.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(parentCommitTxid);
  const parentRevealTxid = await postTx(parent.revealHex);
  expect(parentRevealTxid).toBe(parent.revealTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(parentRevealTxid);
  const parentInscriptionId = `${parentRevealTxid}i0`;

  const ordUtxosAfterParent = await getUtxos(ordinalsAddress);
  const parentUtxo = ordUtxosAfterParent.find(u => u.txid === parentRevealTxid && u.vout === 0);
  if (!parentUtxo) throw new Error('parent inscription UTXO not found at ordinalsAddress');
  expect(parentUtxo.value).toBe(CAT21_POSTAGE_SATS);

  // ── Step 2: inscribe the CHILD (2 popups: commit + reveal parent) ──
  const childFunding = await fundPaymentAddress(paymentAddress);
  // Arm a gate the harness awaits BETWEEN the commit sign and the reveal
  // sign. Xverse's modern signPsbt request (the reveal) hangs — no popup,
  // request never resolves — if it is issued while the preceding commit
  // popup is still closing. The harness blocks on this gate after the
  // commit sign; we open it below only once we have approved AND closed
  // the commit popup, so the reveal request always fires into an idle
  // wallet. (Only this spec arms the gate; other wallets' child specs
  // leave it unset and the harness proceeds without waiting.)
  await harness.evaluate(() => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    (window as unknown as { __ordpoolRevealGate?: { wait: () => Promise<void>; open: () => void } })
      .__ordpoolRevealGate = { wait: () => gate, open };
  });
  const childSignKnown = new Set(context.pages());
  const childPromise = harness.evaluate((args) => window.ordpoolSdkHarness.runOperation(args), {
    kind: 'inscribe-child' as const,
    walletType: 'xverse' as const,
    utxo: childFunding,
    paymentAddress,
    paymentPublicKey: wallet.paymentPublicKey,
    recipientAddress: ordinalsAddress,
    bodyHex: utf8ToHex(CHILD_BODY_TEXT),
    contentType: CONTENT_TYPE,
    feeRatePerVbyte: 5,
    parentInscriptionId,
    parentUtxo: {
      txid: parentUtxo.txid,
      vout: parentUtxo.vout,
      value: parentUtxo.value,
      scriptPubKeyHex: parentScriptPubKeyHex,
      tapInternalKeyHex: ordinalsXOnlyHex,
    },
    parentReturnAddress: ordinalsAddress,
  });
  await approveXverseSignPopup(context, childSignKnown, '02-child-commit-sign');
  // Commit popup approved + closed → release the harness to fire the reveal
  // signPsbt request into an idle wallet (see the gate rationale above).
  await harness.evaluate(() =>
    (window as unknown as { __ordpoolRevealGate?: { open: () => void } }).__ordpoolRevealGate?.open());
  await approveXverseSignPopup(context, childSignKnown, '03-child-reveal-parent-sign');
  const child = await childPromise;
  if (child.kind !== 'inscribe-child') throw new Error('expected inscribe-child result');
  expect(child.childInscriptionId).toBe(`${child.revealTxid}i0`);

  const childCommitTxid = await postTx(child.commitHex);
  expect(childCommitTxid).toBe(child.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(childCommitTxid);

  const childRevealTxid = await postTx(child.revealHex);
  expect(childRevealTxid).toBe(child.revealTxid);
  await waitForElectrsSync(mineBlocks(1));
  const childRevealTx = await waitForTxConfirmed(childRevealTxid);
  expect(childRevealTx.status.block_hash).toBeTruthy();
  expect(childRevealTx.locktime).toBe(21);

  // ── Step 3: verify the child links the parent (ordpool-parser) ──
  const witnessHex = (childRevealTx as unknown as { vin: { witness: string[] }[] }).vin[1].witness;
  const parsed = InscriptionParserService.parse({ txid: childRevealTxid, vin: [{ witness: witnessHex }] });
  expect(parsed.length).toBe(1);
  expect(parsed[0].contentType).toBe(CONTENT_TYPE);
  expect(new TextDecoder().decode(parsed[0].getDataRaw())).toBe(CHILD_BODY_TEXT);
  expect(parsed[0].getParents()).toContain(parentInscriptionId);

  // ── Step 4: on-chain, the parent RETURNED to the wallet (nothing lost) ──
  const ordUtxosAfterChild = await getUtxos(ordinalsAddress);
  const parentReturn = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 0);
  if (!parentReturn) throw new Error('parent-return UTXO not found after child reveal');
  expect(parentReturn.value).toBe(CAT21_POSTAGE_SATS);
  const childUtxo = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 1);
  if (!childUtxo) throw new Error('child UTXO not found at ordinalsAddress');
  expect(childUtxo.value).toBe(CAT21_POSTAGE_SATS);
  expect(ordUtxosAfterChild.find(u => u.txid === parentRevealTxid && u.vout === 0)).toBeUndefined();
});
