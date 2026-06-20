import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { InscriptionParserService } from 'ordpool-parser';

import {
  waitForElectrsSync,
  waitForUtxoAt,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
} from '../../regtest/regtest-helpers';
import { waitForApprovalPopup } from '../approval-popup';

/**
 * Full inscribe roundtrip with the real Xverse extension.
 *
 * Flow:
 *   1. Unlock the seeded Xverse wallet on regtest. Connect via the
 *      SDK harness (xverseConnector.connect).
 *   2. Fund the payment address via bitcoind RPC, mine, wait for
 *      electrs to index the UTXO.
 *   3. Hand the UTXO + the inscription body to the harness — it
 *      runs `createInscribeTransactions`, asks Xverse to sign the
 *      commit (only the funding input — the reveal is finalized
 *      inside the orchestrator with an ephemeral key it then zeroes).
 *   4. Broadcast the commit via local electrs. Mine 1 block so the
 *      commit UTXO is confirmed and spendable.
 *   5. Broadcast the reveal via local electrs. Mine 1 block.
 *   6. Fetch the reveal tx by txid, parse via ordpool-parser's
 *      InscriptionParserService, verify content roundtrip.
 *
 * The byte-equal content-roundtrip via the parser is the
 * acceptance criterion: it proves the inscription is recoverable
 * by every downstream ordpool consumer the same way.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const TEST_PASSWORD = 'TestPassword123!';
const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../../test-results/xverse-seed-user-data-dir');

const FUND_AMOUNT_BTC = 0.001;

const INSCRIPTION_BODY_TEXT = 'hello inscribe from regtest';
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `inscribe-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

function utf8ToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }
  if (!fs.existsSync(path.join(SEED_USER_DATA_DIR, 'Default'))) {
    throw new Error(`Xverse seed user-data-dir missing at ${SEED_USER_DATA_DIR}.`);
  }

  try {
    execFileSync(
      'docker',
      [
        'exec',
        'ordpool-e2e-bitcoind',
        'bitcoin-cli',
        '-regtest',
        '-rpcuser=ordpool',
        '-rpcpassword=ordpool',
        'getblockchaininfo',
      ],
      { stdio: 'ignore' },
    );
  } catch (e) {
    throw new Error(`bitcoind regtest container not reachable: ${(e as Error).message}`);
  }
  const tip = Number(rpc('getblockcount').trim());
  if (tip < 101) {
    throw new Error(`regtest tip is ${tip} (<101). Run e2e/regtest-bootstrap.sh before this spec.`);
  }

  const workingDir = `${SEED_USER_DATA_DIR}.inscribespec-${process.pid}-${Date.now()}`;
  fs.cpSync(SEED_USER_DATA_DIR, workingDir, { recursive: true });
  for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(workingDir, stale), { force: true });
  }

  context = await chromium.launchPersistentContext(workingDir, {
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
});

test.afterAll(async () => {
  await context?.close();
});

test('inscribe an artifact on regtest via xverse: build commit+reveal in SDK, sign commit in Xverse popup, broadcast both via local electrs, verify via ordpool-parser', async () => {
  test.setTimeout(360_000);

  // ─── Unlock + dashboard ready ───────────────────────────────────
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
      return t.includes('account 1') || t.includes('not now') || t.includes('zest') || t.includes('send');
    }, undefined, { timeout: 30_000, polling: 250 });
  }
  const notNow = primer.getByText('Not now', { exact: true }).first();
  if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await notNow.click({ force: true }).catch(() => undefined);
  }
  await shot(primer, '01-dashboard-ready');

  // ─── Connect via the SDK harness ────────────────────────────────
  const harness = await context.newPage();
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
  // eslint-disable-next-line no-console
  console.log(`[inscribe] payment=${wallet.paymentAddress} ordinals=${wallet.ordinalsAddress}`);
  expect(wallet.paymentAddress).toMatch(/^bcrt1q/);
  expect(wallet.ordinalsAddress).toMatch(/^bcrt1p/);

  // ─── Fund the payment address ──────────────────────────────────
  const fundTxid = rpc(
    '-rpcwallet=ordpool-e2e', 'sendtoaddress', wallet.paymentAddress, String(FUND_AMOUNT_BTC),
  ).trim();
  // eslint-disable-next-line no-console
  console.log(`[inscribe] funded with ${FUND_AMOUNT_BTC} BTC via ${fundTxid}`);
  await waitForElectrsSync(mineBlocks(1));
  const utxo = await waitForUtxoAt(wallet.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ─── Build commit+reveal + sign commit via Xverse popup ────────
  const knownPagesAtStart = new Set(context.pages());
  const signedPromise = harness.evaluate((args) => window.ordpoolSdkHarness.buildAndSignInscribeViaXverse(args), {
    utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
    paymentAddress: wallet.paymentAddress,
    paymentPublicKey: wallet.paymentPublicKey,
    recipientAddress: wallet.ordinalsAddress,
    bodyHex: utf8ToHex(INSCRIPTION_BODY_TEXT),
    contentType: INSCRIPTION_CONTENT_TYPE,
    feeRatePerVbyte: 5,
  });

  let approvalSign: Page;
  try {
    approvalSign = await waitForApprovalPopup({
      context,
      knownPages: knownPagesAtStart,
      timeoutMs: 120_000,
      isApproval: async (p) => {
        if (!p.url().startsWith('chrome-extension://')) return false;
        await p.getByText(/review transaction/i).first()
          .waitFor({ state: 'visible', timeout: 120_000 });
        return true;
      },
    });
  } catch {
    throw new Error('Xverse sign popup never rendered Review transaction within 120s');
  }
  await shot(approvalSign, '02-commit-sign-approval');

  await approvalSign.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(b => {
      if (!/^confirm$/i.test(b.textContent?.trim() ?? '')) return false;
      if (b.hasAttribute('disabled')) return false;
      const style = getComputedStyle(b);
      return style.pointerEvents !== 'none' && style.visibility !== 'hidden';
    });
  }, undefined, { timeout: 30_000, polling: 250 });
  await expect(approvalSign.getByRole('button', { name: /^confirm$/i }).first()).toBeEnabled({ timeout: 30_000 });

  let signResolved = false;
  signedPromise.then(() => { signResolved = true; }).catch(() => undefined);
  for (let attempt = 0; attempt < 3 && !signResolved; attempt++) {
    if (approvalSign.isClosed()) break;
    await approvalSign.getByRole('button', { name: /^confirm$/i }).first()
      .click({ force: true })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.log(`[inscribe] confirm-click attempt ${attempt} closed the popup: ${(e as Error).message}`);
      });
    const closePromise = new Promise<void>((res) => approvalSign.once('close', () => res()));
    await Promise.race([
      signedPromise.then(() => undefined).catch(() => undefined),
      closePromise,
      expect(approvalSign.getByRole('button', { name: /^confirm$/i }).first()).toBeHidden({ timeout: 30_000 }),
    ]).catch(() => undefined);
  }
  const signed = await signedPromise;
  // eslint-disable-next-line no-console
  console.log(`[inscribe] commit=${signed.commitTxid.slice(0, 12)}… reveal=${signed.revealTxid.slice(0, 12)}…`);
  expect(signed.commitTxid).toMatch(/^[0-9a-f]{64}$/);
  expect(signed.revealTxid).toMatch(/^[0-9a-f]{64}$/);

  // ─── Broadcast commit → mine → broadcast reveal → mine ──────────
  // Two distinct broadcasts because regtest electrs doesn't expose
  // submitpackage yet. The reveal references the commit's txid as
  // an unconfirmed output; mine 1 block between so the reveal hits
  // an already-mature commit output.
  const commitTxid = await postTx(signed.commitHex);
  expect(commitTxid).toBe(signed.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(commitTxid);
  // eslint-disable-next-line no-console
  console.log(`[inscribe] commit confirmed: ${commitTxid}`);

  const revealTxid = await postTx(signed.revealHex);
  expect(revealTxid).toBe(signed.revealTxid);
  await waitForElectrsSync(mineBlocks(1));
  const revealTx = await waitForTxConfirmed(revealTxid);
  // eslint-disable-next-line no-console
  console.log(`[inscribe] reveal confirmed: ${revealTxid}`);
  expect(revealTx.status.block_hash).toBeTruthy();

  // ─── Parse the reveal as an inscription via ordpool-parser ─────
  const witnessHex = (revealTx as unknown as {
    vin: { witness: string[] }[];
  }).vin[0].witness;
  const parserInput = {
    txid: revealTxid,
    vin: [{ witness: witnessHex }],
  };
  const parsed = InscriptionParserService.parse(parserInput);
  expect(parsed.length).toBe(1);
  expect(parsed[0].contentType).toBe(INSCRIPTION_CONTENT_TYPE);
  const recovered = new TextDecoder().decode(parsed[0].getDataRaw());
  expect(recovered).toBe(INSCRIPTION_BODY_TEXT);
});
