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
 * OKX PARENT/CHILD inscribe roundtrip on regtest — proof that the real
 * OKX binary signs the child reveal's Taproot parent input alongside a
 * pre-finalized ephemeral sibling.
 *
 * OKX (default BIP-86 Taproot) is single-address: payment === ordinals,
 * one `bcrt1p` address. Its plain inscribe already signs a Taproot
 * key-path funding input at that address, so the child's parent input
 * is the SAME signing operation at the SAME address — only now with the
 * commit input already finalized at index 1. Everything (commit funding,
 * parent, child) lives on the one Taproot address.
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

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByText('Connect account').first().waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByRole('button', { name: /^connect$/i }).first().click();
}

/**
 * Approve ONE OKX sign popup and wait for its sign heading to clear, so
 * a subsequent call polls the NEXT request rather than re-approving the
 * one just confirmed (OKX reuses pages + exposes no per-request testid).
 */
async function approveSignPopup(ctx: BrowserContext, tag: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let approval: Page | null = null;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if (!p.url().startsWith('chrome-extension://')) continue;
      const text = await p.locator('body').innerText().catch(() => '');
      if (SIGN_HEADING.test(text)) { approval = p; break; }
    }
    if (approval) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!approval) throw new Error('OKX sign popup never showed the sign heading within 120s');
  await shot(approval, tag);

  const promo = approval.getByText('Asset transfer pending');
  if (await promo.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const closeBtn = approval.locator('button:has(svg), [aria-label="close" i], [aria-label="Close" i]').first();
    if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await closeBtn.click({ force: true }).catch(() => undefined);
    }
    await promo.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  await approval.getByText('Confirm', { exact: true }).first().click();
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

// fixme: OKX's signPsbt cannot sign the two-input child reveal.
// OKX signs both single-input Taproot COMMIT PSBTs fine, but on the child
// reveal (input 0 = the wallet's parent UTXO, input 1 = the EPHEMERAL
// commit UTXO — not OKX's key) its signPsbt hangs: no prompt, the call
// never settles. Proven three ways — input 1 pre-finalized, input 1 as a
// partial tapScriptSig, and input 1 fully BARE (witnessUtxo only) all
// stall identically — so it is not the ord envelope tap-leaf but the mere
// presence of a second, foreign input that OKX's signPsbt can't handle.
// This is a wallet-side limitation (same family as its unproven multi-
// input transfer/offer flows), NOT an SDK defect: the identical reveal is
// signed + broadcast by the index-based wallets (cat21-wallet, Leather —
// both green) and by the SDK regtest e2e against stock ord. Kept as fixme
// (harness path preserved) pending OKX multi-input signPsbt support.
test.fixme('inscribe a parent then a child via OKX: wallet signs the Taproot reveal parent input, parent returns to the wallet, child links to it', async () => {
  test.setTimeout(600_000);

  const harness = await context.newPage();
  // DIAGNOSTIC: surface the harness page's console (the inscribe-child op
  // logs commit-sign-start / commit-signed / reveal-sign-start /
  // reveal-signed) so CI shows exactly how far the child op got.
  // eslint-disable-next-line no-console
  harness.on('console', (m) => console.log(`[H] ${m.text()}`));
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOkx());
  await approveConnectPopup(context, connectKnownPages);
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
  await approveSignPopup(context, '01-parent-commit-sign');
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

  const ordUtxosAfterParent = await getUtxos(taprootAddress);
  const parentUtxo = ordUtxosAfterParent.find(u => u.txid === parentRevealTxid && u.vout === 0);
  if (!parentUtxo) throw new Error('parent inscription UTXO not found at taproot address');
  expect(parentUtxo.value).toBe(CAT21_POSTAGE_SATS);

  // ── Step 2: inscribe the CHILD (2 popups: commit + reveal parent) ──
  const childFunding = await fundPaymentAddress(taprootAddress);
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
  await approveSignPopup(context, '02-child-commit-sign');
  // DIAGNOSTIC: if the reveal (parent-input) sign popup never appears,
  // surface OKX's actual signPsbt rejection from the child op instead of
  // masking it with the popup-timeout error.
  let childErr: Error | undefined;
  childPromise.catch((e) => { childErr = e as Error; });
  try {
    await approveSignPopup(context, '03-child-reveal-parent-sign');
  } catch (popupErr) {
    await new Promise(r => setTimeout(r, 3000)); // let the child op settle
    // eslint-disable-next-line no-console
    console.log(`[okx-child] OKX signPsbt(reveal) error: ${childErr?.message ?? '(still pending / none)'}`);
    throw new Error(
      `[okx-child] reveal parent-input sign popup absent. ` +
      `OKX signPsbt error: ${childErr?.message ?? '(pending/none)'} | popup: ${(popupErr as Error).message}`,
    );
  }
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
  const ordUtxosAfterChild = await getUtxos(taprootAddress);
  const parentReturn = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 0);
  if (!parentReturn) throw new Error('parent-return UTXO not found after child reveal');
  expect(parentReturn.value).toBe(CAT21_POSTAGE_SATS);
  const childUtxo = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 1);
  if (!childUtxo) throw new Error('child UTXO not found at taproot address');
  expect(childUtxo.value).toBe(CAT21_POSTAGE_SATS);
  expect(ordUtxosAfterChild.find(u => u.txid === parentRevealTxid && u.vout === 0)).toBeUndefined();
});
