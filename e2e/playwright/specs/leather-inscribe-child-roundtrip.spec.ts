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
import { onboardLeather } from '../onboard-leather';

/**
 * Leather PARENT/CHILD inscribe roundtrip on regtest — the first proof
 * that the real Leather binary signs a Taproot key-path ordinals input
 * (the child reveal's parent input) alongside a pre-finalized ephemeral
 * sibling. Leather signs each input by index off the PSBT, deriving its
 * key from the network arg (same mechanism as cat21-wallet, its fork,
 * which is green). Plain inscribe only exercises Leather's SegWit
 * funding input; this closes the Taproot-ordinals-signing gap.
 *
 * The PARENT lands at the wallet's Taproot ordinals address (derived
 * from the connect-returned ordinals pubkey) so Leather's own BIP-86
 * key signs it back out on the child reveal.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;
const CAT21_POSTAGE_SATS = 546;
const PARENT_BODY_TEXT = 'leather PARENT collection root';
const CHILD_BODY_TEXT = 'leather CHILD of the collection';
const CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `leather-inscribe-child-${name}.png`),
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
/** Normalise a pubkey hex to x-only (32 bytes): drop the 0x02/0x03 parity byte if present. */
function xOnlyHex(pubHex: string): string {
  const s = pubHex.startsWith('0x') ? pubHex.slice(2) : pubHex;
  return s.length === 66 ? s.slice(2) : s;
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
 * `knownPages` so the NEXT call skips it (the child flow fires two
 * sequential popups: commit funding, then the reveal parent input).
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

/** Fund the wallet's payment address with a fresh UTXO and return it. */
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
  await onboardLeather(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('inscribe a parent then a child via Leather: wallet signs the Taproot reveal parent input, parent returns to the wallet, child links to it', async () => {
  test.setTimeout(600_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectLeather());
  await approveConnectPopup(context, connectKnownPages);
  const walletMainnet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);

  const regtestNetwork = toScureNetwork(Network.Regtest);
  const paymentAddress = btc.p2wpkh(hexBytes(walletMainnet.paymentPublicKey), regtestNetwork).address!;
  const ordinalsXOnlyHex = xOnlyHex(walletMainnet.ordinalsPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only ordinals pubkey').toBe(64);
  const ordinalsAddress = btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).address!;
  expect(paymentAddress).toMatch(/^bcrt1q/);
  expect(ordinalsAddress).toMatch(/^bcrt1p/);
  const parentScriptPubKeyHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script);

  // ── Step 1: inscribe the PARENT at the ordinals address (1 popup) ──
  const parentFunding = await fundPaymentAddress(paymentAddress);
  const parentSignKnown = new Set(context.pages());
  const parentPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'inscribe' as const,
      walletType: 'leather' as const,
      utxo: parentFunding,
      paymentAddress,
      paymentPublicKey: walletMainnet.paymentPublicKey,
      recipientAddress: ordinalsAddress,
      bodyHex: utf8ToHex(PARENT_BODY_TEXT),
      contentType: CONTENT_TYPE,
      feeRatePerVbyte: 5,
    },
  );
  await approveSignPopup(context, parentSignKnown, '01-parent-commit-sign');
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
  const childSignKnown = new Set(context.pages());
  const childPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'inscribe-child' as const,
      walletType: 'leather' as const,
      utxo: childFunding,
      paymentAddress,
      paymentPublicKey: walletMainnet.paymentPublicKey,
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
    },
  );
  await approveSignPopup(context, childSignKnown, '02-child-commit-sign');
  await approveSignPopup(context, childSignKnown, '03-child-reveal-parent-sign');
  const child = await childPromise;
  if (child.kind !== 'inscribe-child') throw new Error('expected inscribe-child result');
  expect(child.childInscriptionId).toBe(`${child.revealTxid}i0`);

  const childCommitTxid = await postTx(child.commitHex);
  expect(childCommitTxid).toBe(child.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(childCommitTxid);

  // The reveal confirming proves Leather signed input 0 (the parent
  // P2TR key-path) correctly — a bad signature is rejected here.
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
  if (!parentReturn) throw new Error('parent-return UTXO not found at ordinalsAddress after child reveal');
  expect(parentReturn.value).toBe(CAT21_POSTAGE_SATS);
  const childUtxo = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 1);
  if (!childUtxo) throw new Error('child UTXO not found at ordinalsAddress');
  expect(childUtxo.value).toBe(CAT21_POSTAGE_SATS);
  expect(ordUtxosAfterChild.find(u => u.txid === parentRevealTxid && u.vout === 0)).toBeUndefined();
});
