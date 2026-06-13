import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { getUtxos, waitForElectrsSync, rpc, mineBlocks, getTx, postTx, assertAllInputsSighashAll } from '../../regtest/regtest-helpers';
import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 3c — full cat21 mint roundtrip with the real Xverse
 * extension. Drives the real Xverse .crx via Playwright (the
 * wallet side) against the local regtest stack (bitcoind +
 * electrs on localhost) for the broadcast side.
 *
 * Flow:
 *   1. Clone the seeded user-data-dir, launch Chromium, unlock the
 *      wallet (already onboarded on Bitcoin Regtest by globalSetup
 *      with electrsApiUrl pointing at our local electrs).
 *   2. Get the wallet's bcrt1q payment + bcrt1p ordinals addresses
 *      via the SDK harness (xverseConnector.connect on Regtest).
 *   3. Fund the payment address via bitcoind RPC, mine a block,
 *      wait for electrs to index, fetch the resulting UTXO.
 *   4. Hand the UTXO + addresses + fee to the harness — it builds
 *      the cat21 mint PSBT via cat21.service.helper.createTransaction
 *      and calls xverseSigner.signAndBroadcast. Xverse asks the
 *      user for sign approval in its popup window; the spec
 *      auto-confirms.
 *   5. Mine 1 block. Wait for electrs to confirm. Verify the
 *      resulting tx parses as a cat21 via ordpool-parser.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const TEST_PASSWORD = 'TestPassword123!';
const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../../test-results/xverse-seed-user-data-dir');

// In regtest 1 BTC = 100M sats; fund the wallet with 0.001 BTC so
// the mint has plenty of headroom plus a meaningful change output.
const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }
  if (!fs.existsSync(path.join(SEED_USER_DATA_DIR, 'Default'))) {
    throw new Error(`Xverse seed user-data-dir missing at ${SEED_USER_DATA_DIR}. globalSetup should have produced it.`);
  }

  // bitcoind health check + ensure 101 blocks mined (coinbase
  // maturity). e2e/regtest-bootstrap.sh would do this too, but
  // we can't shell out from a Playwright spec without making the
  // workflow run it explicitly, so duplicate the minimal check
  // inline.
  try {
    execFileSync('docker', ['exec', 'ordpool-e2e-bitcoind', 'bitcoin-cli', '-regtest', '-rpcuser=ordpool', '-rpcpassword=ordpool', 'getblockchaininfo'], { stdio: 'ignore' });
  } catch (e) {
    throw new Error(`bitcoind regtest container not reachable: ${(e as Error).message}`);
  }
  const tip = Number(rpc('getblockcount').trim());
  if (tip < 101) {
    throw new Error(`regtest tip is ${tip} (<101). Run e2e/regtest-bootstrap.sh before this spec.`);
  }

  const workingDir = `${SEED_USER_DATA_DIR}.mintspec-${process.pid}-${Date.now()}`;
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

test('mint a cat21 on regtest via xverse: build PSBT in SDK, sign in Xverse popup, broadcast via local electrs, verify via parser', async () => {
  // The full roundtrip walks several Xverse popups (connect-
  // approval + sign-approval) plus bitcoind RPC + electrs polling.
  // Bump beyond the suite-default 60s.
  test.setTimeout(300_000);

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

  // ─── Get the wallet's bcrt1 addresses via the SDK harness ──────
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
  // Xverse leaves the connect popup tab open after approval; in CI
  // it then displays the wallet dashboard. When signTransaction
  // fires later, Xverse sometimes reuses that tab — but our
  // `knownPagesAtStart` snapshot below would filter it, so
  // waitForApprovalPopup never sees the "Review transaction" page
  // and times out at 120s. Closing it forces Xverse to open a
  // fresh tab for the sign step, which `context.on('page')`
  // reliably catches.
  await approvalConnect.close().catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log(`[mint] payment = ${wallet.paymentAddress}  ordinals = ${wallet.ordinalsAddress}`);
  expect(wallet.paymentAddress).toMatch(/^bcrt1q/);
  expect(wallet.ordinalsAddress).toMatch(/^bcrt1p/);

  // ─── Fund the payment address from bitcoind ────────────────────
  // sendtoaddress charges fees from the wallet automatically;
  // returns the funding txid.
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', wallet.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  // eslint-disable-next-line no-console
  console.log(`[mint] funded ${wallet.paymentAddress} with ${FUND_AMOUNT_BTC} BTC in tx ${fundTxid}`);
  const newTip = mineBlocks(1);
  await waitForElectrsSync(newTip);

  const utxos = await getUtxos(wallet.paymentAddress);
  expect(utxos.length).toBeGreaterThan(0);
  const utxo = utxos.find(u => u.value === Math.round(FUND_AMOUNT_BTC * 1e8));
  if (!utxo) throw new Error(`could not find ${FUND_AMOUNT_BTC} BTC UTXO at ${wallet.paymentAddress}; got ${JSON.stringify(utxos)}`);
  // eslint-disable-next-line no-console
  console.log(`[mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  // ─── Build + sign mint PSBT via SDK + Xverse popup, then ──────
  //     broadcast via local electrs from this Node side. We avoid
  //     Xverse's own broadcast because the mempool/electrs HTTP
  //     server rejects axios's JSON content-type with HTTP 400.
  const knownPagesAtStart = new Set(context.pages());
  const signedHexPromise = harness.evaluate((args) => window.ordpoolSdkHarness.buildAndSignMintViaXverse(args), {
    utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
    paymentAddress: wallet.paymentAddress,
    paymentPublicKey: wallet.paymentPublicKey,
    recipientAddress: wallet.ordinalsAddress,
    feeSats: 1500,
  });
  // Find the sign popup specifically by looking for "Review
  // transaction" text — the loading-spinner state must finish
  // first. Plain waitForEvent('page') can race against earlier
  // events that fired during connect.
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
  await shot(approvalSign, '02-sign-approval');
  // Wait until Confirm is enabled (Xverse renders the button
  // immediately but its React onClick is hooked up only after
  // the fee/details async-resolve).
  await approvalSign.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(b => {
      if (!/^confirm$/i.test(b.textContent?.trim() ?? '')) return false;
      if (b.hasAttribute('disabled')) return false;
      const style = getComputedStyle(b);
      return style.pointerEvents !== 'none' && style.visibility !== 'hidden';
    });
  }, undefined, { timeout: 30_000, polling: 250 });

  // Confirm-binding gate: wait for the React onClick to be attached
  // by checking that the button is interactive (no `disabled` attr,
  // pointer-events not 'none', no in-flight spinner overlay). The
  // waitForFunction above already gates `disabled` + pointer-events;
  // pin the visibility of "Confirm" once more as an explicit barrier
  // so the next click can't land in the pre-binding window.
  await expect(approvalSign.getByRole('button', { name: /^confirm$/i }).first()).toBeEnabled({ timeout: 30_000 });

  // Click Confirm with a retry loop. Either the click lands and
  // Xverse closes the popup itself (success), or Xverse signs and
  // the harness's signedHexPromise resolves (also success), so
  // both page-close-error AND signedHexPromise-completion count as
  // wins. Each attempt awaits a Promise.race(signed, page-close)
  // so we never sleep blindly.
  let signResolved = false;
  signedHexPromise.then(() => { signResolved = true; }).catch(() => undefined);
  for (let attempt = 0; attempt < 3 && !signResolved; attempt++) {
    if (approvalSign.isClosed()) break;
    await approvalSign.getByRole('button', { name: /^confirm$/i }).first()
      .click({ force: true })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.log(`[mint] confirm-click attempt ${attempt} closed the popup: ${(e as Error).message}`);
      });
    // Race three observables: signedHexPromise resolves (sign
    // succeeded), the popup's `close` event fires (Xverse closed it
    // post-sign), OR the Confirm button disappears (screen
    // transitioned away). Whichever wins, exit the attempt loop or
    // retry. expect.toBeHidden carries its own deadline so the race
    // can't hang indefinitely if the click was silently swallowed.
    const closePromise = new Promise<void>((res) => approvalSign.once('close', () => res()));
    await Promise.race([
      signedHexPromise.then(() => undefined).catch(() => undefined),
      closePromise,
      expect(approvalSign.getByRole('button', { name: /^confirm$/i }).first()).toBeHidden({ timeout: 30_000 }),
    ]).catch(() => undefined);
  }
  const signed = await signedHexPromise;
  // eslint-disable-next-line no-console
  console.log(`[mint] signed tx hex (${signed.txHex.length} chars), broadcasting via local electrs…`);

  const broadcastTxid = await postTx(signed.txHex);
  // eslint-disable-next-line no-console
  console.log(`[mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  // ─── Confirm the tx, fetch via Esplora, parse as cat21 ──────────
  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await getTx(broadcastTxid);
  // eslint-disable-next-line no-console
  console.log(`[mint] locktime=${esploraTx.locktime}  block_hash=${esploraTx.status.block_hash}`);
  expect(esploraTx.locktime).toBe(21);
  expect(esploraTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(esploraTx);

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
