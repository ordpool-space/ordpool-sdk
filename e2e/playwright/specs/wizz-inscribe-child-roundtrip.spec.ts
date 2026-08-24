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

/**
 * Wizz PARENT/CHILD inscribe roundtrip on regtest: proof that the real
 * Wizz binary signs the child reveal's Taproot parent input alongside a
 * pre-finalized ephemeral sibling. Wizz is a Unisat fork, so the address
 * model and sign path match Unisat's.
 *
 * Wizz is single-KEY, dual-ADDRESS: one compressed pubkey yields the
 * bcrt1q (BIP-84) payment address AND the bcrt1p (BIP-86) ordinals
 * address (the same x-only key). The commit funds from the segwit
 * payment address; the PARENT lands on the Taproot ordinals address so
 * Wizz's own key signs it back out on the child reveal. Same
 * network-agnostic-keys trick as `wizz-inscribe-roundtrip.spec.ts`: Wizz
 * runs on mainnet but its script-hash matching is HRP-independent, so a
 * regtest-encoded PSBT signs cleanly.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/wizz');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const FUND_AMOUNT_BTC = 0.001;
const CAT21_POSTAGE_SATS = 546;
const PARENT_BODY_TEXT = 'wizz PARENT collection root';
const CHILD_BODY_TEXT = 'wizz CHILD of the collection';
const CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `wizz-inscribe-child-${name}.png`),
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

async function onboardWizz(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByText('I already have a wallet', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByText('I already have a wallet', { exact: true }).click();

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  const pwCount = await pwInputs.count();
  for (let i = 0; i < pwCount; i++) {
    await pwInputs.nth(i).fill(TEST_PASSWORD);
  }
  await page.getByRole('button', { name: /^continue$/i }).first().click();

  await expect(page.getByText('Wizz Wallet', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText('Wizz Wallet', { exact: true }).first().click({ force: true });

  const mnemonicInputs = page.locator('input[type="text"], input[type="password"]');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await page.getByRole('button', { name: /^continue$/i }).first().click();

  await expect(page.getByText('Native Segwit (P2WPKH)', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText('Native Segwit (P2WPKH)', { exact: true }).first().click({ force: true });
  const continueBtn = page.getByRole('button', { name: /^continue$/i }).last();
  await continueBtn.scrollIntoViewIfNeeded();
  await continueBtn.click();

  await expect(page.getByText('Security Tips', { exact: true })).toBeVisible({ timeout: 10_000 });
  const checkboxes = page.locator('label.ant-checkbox-wrapper');
  await expect(checkboxes).toHaveCount(3, { timeout: 10_000 });
  const cbCount = await checkboxes.count();
  for (let i = 0; i < cbCount; i++) {
    await checkboxes.nth(i).click();
  }
  await page.getByRole('button', { name: /^ok$/i }).click();

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('receive') || t.includes('send') || t.includes('balance');
  }, undefined, { timeout: 60_000, polling: 500 });
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

/**
 * Wait for a Wizz sign popup, approve it, and register it in
 * `knownPages` so the NEXT call skips it (the child flow fires two
 * sequential popups: commit funding, then the reveal parent input).
 */
async function approveSignPopup(ctx: BrowserContext, knownPages: Set<Page>, tag: string): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 120_000,
    isApproval: async (p) => {
      await p.waitForURL(/notification\.html#\/approval/, { timeout: 120_000 });
      return true;
    },
  });
  await shot(approval, tag);
  await approval.waitForFunction(() => {
    const isSignButton = (el: Element) => {
      const text = (el.textContent || '').trim();
      return /^\s*[⠀-⣿•●]?\s*Sign\s*$/i.test(text);
    };
    const els = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], div'));
    const candidate = els.find(isSignButton);
    if (!candidate) return null;
    const style = getComputedStyle(candidate);
    if (style.pointerEvents === 'none') return null;
    if (parseFloat(style.opacity) < 0.7) return null;
    candidate.click();
    return true;
  }, undefined, { timeout: 60_000, polling: 250 });
  await shot(approval, `${tag}-after-sign-click`).catch(() => undefined);
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
    throw new Error(`Wizz extension not unpacked at ${EXT_PATH}.`);
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
  await onboardWizz(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('inscribe a parent then a child via Wizz: wallet signs the Taproot reveal parent input, parent returns to the wallet, child links to it', async () => {
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
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectWizz());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);

  // Single-KEY, dual-ADDRESS: the bcrt1q payment address and the bcrt1p
  // ordinals address both derive from the connect-returned payment
  // pubkey (x-only for the Taproot leg), so the parent's tapInternalKey
  // is that same key and Wizz signs it back out on the child reveal.
  const regtestNetwork = toScureNetwork(Network.Regtest);
  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  const paymentAddress = regtest.paymentAddress;
  const ordinalsAddress = regtest.ordinalsAddress;
  expect(paymentAddress).toMatch(/^bcrt1q/);
  expect(ordinalsAddress).toMatch(/^bcrt1p/);
  const ordinalsXOnlyHex = xOnlyHex(wallet.paymentPublicKey);
  expect(ordinalsXOnlyHex.length, 'x-only ordinals pubkey').toBe(64);
  const parentScriptPubKeyHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script);

  // ── Step 1: inscribe the PARENT at the ordinals address (1 popup) ──
  const parentFunding = await fundPaymentAddress(paymentAddress);
  const parentSignKnown = new Set(context.pages());
  const parentPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'inscribe' as const,
      walletType: 'wizz' as const,
      utxo: parentFunding,
      paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
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
      walletType: 'wizz' as const,
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

  // The reveal confirming proves Wizz signed input 0 (the parent P2TR
  // key-path) correctly; a bad signature is rejected here.
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
