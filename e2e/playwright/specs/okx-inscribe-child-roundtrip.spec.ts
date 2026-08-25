import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
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
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { onboardOkx } from '../onboard-okx';

/**
 * OKX PARENT/CHILD inscribe on regtest.
 *
 * The reveal spends the parent (input 0, an OKX key-path Taproot input) plus
 * the ord envelope commit (input 1). OKX is handed the BARE reveal PSBT (input
 * 1 stripped of the envelope tap-leaf, so a plain witnessUtxo) and signs ONLY
 * input 0 at the ordinals address via signPsbt; the SDK merges that signature
 * into the full PSBT. Same "sign my input, leave the foreign one" shape as the
 * offer flows, and it works on OKX v4.1.0: the [child] logs show both the
 * commit and reveal-parent signs completing and a valid child inscription
 * (ordpool-parser confirms the parent link).
 *
 * OKX is bimodal at every interaction (popup that must be approved, or
 * silent completion for the connected dApp), so every popup wait in this
 * spec runs concurrently with its operation promise and exits on a
 * done-flag; leftover OKX pages are cleared after every sign. See the note
 * above the test for the full interaction model.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;
const CAT21_POSTAGE_SATS = 546;
const PARENT_BODY_TEXT = 'okx PARENT collection root';
const CHILD_BODY_TEXT = 'okx CHILD of the collection';
const CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `okx-inscribe-child-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
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

const SIGN_HEADING = /Signature request|Confirm Trade|Asset transfer pending/i;

/**
 * Approve the OKX "Connect account" popup, tolerating both of OKX's modes:
 * an already-approved dApp auto-connects (the popup flashes shut or never
 * opens — `done` flips and we return), and a fresh dApp shows the popup
 * (we click Connect, swallowing the close-race if OKX dismisses it mid-click).
 */
async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>, done: () => boolean): Promise<void> {
  const approval = await Promise.race([
    waitForApprovalPopup({
      context: ctx,
      knownPages,
      isApproval: async (p) => {
        if (!p.url().startsWith('chrome-extension://')) return false;
        await p.getByText('Connect account').first().waitFor({ state: 'visible', timeout: 60_000 });
        return true;
      },
    }),
    (async () => {
      while (!done()) await new Promise(r => setTimeout(r, 250));
      return null;
    })(),
  ]);
  if (!approval) return; // auto-connected, no popup to approve
  await approval.getByRole('button', { name: /^connect$/i }).first().click()
    .catch(() => undefined); // popup closed as OKX auto-approved: fine
}

/**
 * Approve ONE OKX sign popup and wait for its sign heading to clear, so
 * a subsequent call polls the NEXT request rather than re-approving the
 * one just confirmed (OKX reuses pages + exposes no per-request testid).
 */
async function approveSignPopup(ctx: BrowserContext, tag: string, isDone?: () => boolean): Promise<void> {
  const deadline = Date.now() + 120_000;
  let approval: Page | null = null;
  while (Date.now() < deadline) {
    // Best-effort: current OKX auto-approves signPsbt for the connected dapp
    // without a persistent interactive popup (same as mint/transfer/offers),
    // so if the operation already completed, stop polling — there is no popup
    // to approve.
    if (isDone?.()) return;
    for (const p of ctx.pages()) {
      if (!p.url().startsWith('chrome-extension://')) continue;
      const text = await p.locator('body').innerText().catch(() => '');
      if (SIGN_HEADING.test(text)) { approval = p; break; }
    }
    if (approval) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!approval) {
    if (isDone?.()) return;
    throw new Error('OKX sign popup never showed the sign heading within 120s');
  }
  await shot(approval, tag);

  const promo = approval.getByText('Asset transfer pending');
  if (await promo.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const closeBtn = approval.locator('button:has(svg), [aria-label="close" i], [aria-label="Close" i]').first();
    if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await closeBtn.click({ force: true }).catch(() => undefined);
    }
    await promo.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  // Close-race guard: OKX may complete the sign and shut the popup while the
  // click is in flight ("guid not bound" / target-closed). The sign already
  // succeeded in that case, so swallow the click error; the caller's
  // operation-promise await settles the true outcome.
  await approval.getByText('Confirm', { exact: true }).first().click()
    .catch(() => undefined);
  // Wait for this request's heading to disappear so the next poll can't
  // re-detect the request we just confirmed.
  await approval.waitForFunction(
    () => !/Signature request|Confirm Trade/i.test(document.body.innerText || ''),
    undefined,
    { timeout: 30_000 },
  ).catch(() => undefined);
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

  // OKX auto-opens its onboarding page on extension load; adopt it if it
  // appears, else fall back to a fresh page. Extend the hook timeout —
  // OKX onboarding (iframe seed form + "Secure your wallet" new page)
  // runs well past the default per-test timeout.
  let onboardPage: Page | undefined;
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

// OKX is bimodal at every interaction: it either shows an approval popup
// (connect / sign) that MUST be clicked, or completes silently for the
// connected dApp. Each popup wait therefore runs CONCURRENTLY with the
// operation promise and exits on a done-flag; awaiting the operation before
// approving deadlocks the popup mode, and strictly awaiting a popup times out
// in the silent mode. Leftover OKX pages are cleared after every sign (the
// same hygiene the stable okx-transfer spec uses), and the reveal gate
// sequences the child's two signs. The operation itself is proven: both signs
// complete and produce a valid child inscription (ordpool-parser confirms the
// parent link).
test('inscribe a parent then a child via OKX: wallet signs the Taproot reveal parent input, parent returns to the wallet, child links to it', async () => {
  test.setTimeout(600_000);

  const harness = await context.newPage();
  // Forward the harness page's console so the [child] commit/reveal-sign
  // progress markers surface in CI (diagnostic for where the op stalls).
  // eslint-disable-next-line no-console
  harness.on('console', (m) => console.log(`[H] ${m.text()}`));
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const connectKnownPages = new Set(context.pages());
  let connectDone = false;
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOkx())
    .then((r) => { connectDone = true; return r; });
  await approveConnectPopup(context, connectKnownPages, () => connectDone);
  const walletMainnet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);

  // Single-address BIP-86 Taproot: payment === ordinals === bcrt1p, one key.
  const regtestNetwork = toScureNetwork(Network.Regtest);
  const ordinalsXOnlyHex = xOnlyHex(walletMainnet.paymentPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only pubkey').toBe(64);
  const taprootAddress = btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).address!;
  expect(taprootAddress).toMatch(/^bcrt1p/);
  const scriptPubKeyHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script);

  // ── Step 1: inscribe the PARENT (1 popup, Taproot funding) ──
  const parentFunding = await fundPaymentAddress(taprootAddress);
  const parentPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'inscribe' as const,
      walletType: 'okx' as const,
      utxo: parentFunding,
      paymentAddress: taprootAddress,
      paymentPublicKey: walletMainnet.paymentPublicKey,
      recipientAddress: taprootAddress,
      bodyHex: utf8ToHex(PARENT_BODY_TEXT),
      contentType: CONTENT_TYPE,
      feeRatePerVbyte: 5,
    },
  );
  // OKX either shows a sign popup (approve it) or signs silently for the
  // connected dApp (parentDone flips and the popup wait exits) — handle both.
  let parentDone = false;
  const settledParent = parentPromise.then(
    (v) => { parentDone = true; return v; },
    (e) => { parentDone = true; throw e; },
  );
  await approveSignPopup(context, '01-parent-commit-sign', () => parentDone);
  const parent = await settledParent;
  if (parent.kind !== 'inscribe') throw new Error('expected inscribe result for parent');
  // Clear OKX's leftover popup/notification pages before the child's signs
  // (the stable okx-transfer spec does the same between its two signs).
  await closeLeftoverExtensionPages(context, connectKnownPages);

  const parentCommitTxid = await postTx(parent.commitHex);
  expect(parentCommitTxid).toBe(parent.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(parentCommitTxid);

  const parentRevealTxid = await postTx(parent.revealHex);
  expect(parentRevealTxid).toBe(parent.revealTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(parentRevealTxid);
  const parentInscriptionId = `${parentRevealTxid}i0`;

  const ordUtxosAfterParent = await getUtxos(taprootAddress);
  const parentUtxo = ordUtxosAfterParent.find(u => u.txid === parentRevealTxid && u.vout === 0);
  if (!parentUtxo) throw new Error('parent inscription UTXO not found at taproot address');
  expect(parentUtxo.value).toBe(CAT21_POSTAGE_SATS);

  // ── Step 2: inscribe the CHILD (2 popups: commit + reveal parent) ──
  const childFunding = await fundPaymentAddress(taprootAddress);
  // The reveal gate sequences the child's two signs: the harness pauses after
  // the commit sign and we release the reveal only once the commit has settled
  // and OKX's leftover pages are cleared, so the reveal fires into an idle
  // wallet. Popup approval below runs CONCURRENTLY with each sign, because OKX
  // either shows a sign popup (must be approved for the sign to complete) or
  // signs silently (the done-flag exits the popup wait) — awaiting the sign
  // BEFORE approving would deadlock the popup mode.
  await harness.evaluate(() => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    (window as unknown as { __ordpoolRevealGate?: { wait: () => Promise<void>; open: () => void } }).__ordpoolRevealGate = { wait: () => gate, open };
  });
  let commitSignedFlag = false;
  const commitSigned = harness.waitForEvent('console', {
    predicate: (m) => m.text().includes('[child] commit-signed'),
    timeout: 120_000,
  }).then(() => { commitSignedFlag = true; }).catch(() => undefined);
  const childPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'inscribe-child' as const,
      walletType: 'okx' as const,
      utxo: childFunding,
      paymentAddress: taprootAddress,
      paymentPublicKey: walletMainnet.paymentPublicKey,
      recipientAddress: taprootAddress,
      bodyHex: utf8ToHex(CHILD_BODY_TEXT),
      contentType: CONTENT_TYPE,
      feeRatePerVbyte: 5,
      parentInscriptionId,
      parentUtxo: {
        txid: parentUtxo.txid,
        vout: parentUtxo.vout,
        value: parentUtxo.value,
        scriptPubKeyHex: scriptPubKeyHex,
        tapInternalKeyHex: ordinalsXOnlyHex,
      },
      parentReturnAddress: taprootAddress,
    },
  );
  // Track completion so the concurrent popup waits can exit in OKX's
  // silent-sign mode (see the interaction-model note above the test).
  let childDone = false;
  const settledChild = childPromise.then(
    (v) => { childDone = true; return v; },
    (e) => {
      childDone = true;
      // eslint-disable-next-line no-console
      console.log('[okx-child:diag] childPromise rejected: ' + ((e as Error)?.message ?? String(e)));
      throw e;
    },
  );
  // Approve the commit popup concurrently with the sign (exits when OKX
  // auto-signed instead), then wait for the commit sign to settle. Racing
  // settledChild covers an early rejection (build error) so we don't sit out
  // the commitSigned timeout.
  await approveSignPopup(context, '02-child-commit-sign', () => commitSignedFlag || childDone);
  await Promise.race([commitSigned, settledChild.then(() => undefined, () => undefined)]);
  // Commit sign settled → clear leftover pages, release the reveal, approve
  // its popup (if OKX shows one).
  await closeLeftoverExtensionPages(context, [harness]);
  await harness.evaluate(() =>
    (window as unknown as { __ordpoolRevealGate?: { open: () => void } }).__ordpoolRevealGate?.open());
  await approveSignPopup(context, '03-child-reveal-parent-sign', () => childDone);
  const child = await settledChild;
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
  const ordUtxosAfterChild = await getUtxos(taprootAddress);
  const parentReturn = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 0);
  if (!parentReturn) throw new Error('parent-return UTXO not found after child reveal');
  expect(parentReturn.value).toBe(CAT21_POSTAGE_SATS);
  const childUtxo = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 1);
  if (!childUtxo) throw new Error('child UTXO not found at taproot address');
  expect(childUtxo.value).toBe(CAT21_POSTAGE_SATS);
  expect(ordUtxosAfterChild.find(u => u.txid === parentRevealTxid && u.vout === 0)).toBeUndefined();
});
