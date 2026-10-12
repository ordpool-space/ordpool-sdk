import { test, expect, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { waitForElectrsSync, waitForUtxoAt, waitForTxConfirmed, rpc, mineBlocks, postTx, assertAllInputsSighashAll, assertCatLandsAtRecipient, HARNESS_URL } from '../../regtest/regtest-helpers';
import { closeLeftoverExtensionPages } from '../approval-popup';
import { installContextErrorGuard } from '../browser-error-guard';
import { SEED_USER_DATA_DIR } from '../global-setup';
import { installXverseOfflineRoutes } from '../xverse-offline-routes';
import { approveXverseConnect, approveXverseSignPopup, unlockXverse } from '../xverse-popup';
import { launchWalletContext } from '../launch-wallet-context';

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

// In regtest 1 BTC = 100M sats; fund the wallet with 0.001 BTC so
// the mint has plenty of headroom plus a meaningful change output.
const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;
let errorGuard: ReturnType<typeof installContextErrorGuard>;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}. This is a missing prerequisite, not a test failure: run e2e/playwright/playwright-bootstrap.sh xverse.`);
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
    rpc('getblockchaininfo');
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

  context = await launchWalletContext({
    wallet: 'xverse',
    extensionPath: EXT_PATH,
    userDataDir: workingDir,
  });
  await installXverseOfflineRoutes(context);
  // The browser-error guard covers every app page the context spawns (the
  // harness page); wallet-extension pages are outside it.
  errorGuard = installContextErrorGuard(context);
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
});

test.beforeEach(() => {
  errorGuard?.resetPerTest();
});

test.afterEach(() => {
  errorGuard?.assertClean();
});

test.afterAll(async () => {
  await context?.close();
});

test('mint a cat21 on regtest via xverse: build PSBT in SDK, sign in Xverse popup, broadcast via local electrs, verify via parser', async () => {
  // ─── Unlock + dashboard ready ───────────────────────────────────
  const primer = await unlockXverse(context, extensionId);
  await shot(primer, '01-dashboard-ready');

  // ─── Get the wallet's bcrt1 addresses via the SDK harness ──────
  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(() => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true, undefined);

  const wallet = await approveXverseConnect(context, () => harness.evaluate(() => window.ordpoolSdkHarness.connectXverse('regtest')));
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

  // waitForElectrsSync only proves the block tip moved; electrs
  // still needs time to index the tx into per-address UTXO sets.
  // Use the explicit poll so we don't intermittently miss it.
  const utxo = await waitForUtxoAt(wallet.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  // ─── Build + sign mint PSBT via SDK + Xverse popup, then ──────
  //     broadcast via local electrs from this Node side. We avoid
  //     Xverse's own broadcast because the mempool/electrs HTTP
  //     server rejects axios's JSON content-type with HTTP 400.
  const knownPagesAtStart = new Set(context.pages());
  const signedHexPromise = harness.evaluate((args) => window.ordpoolSdkHarness.runOperation(args), {
    kind: 'mint' as const,
    walletType: 'xverse' as const,
    utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
    paymentAddress: wallet.paymentAddress,
    paymentPublicKey: wallet.paymentPublicKey,
    recipientAddress: wallet.ordinalsAddress,
    feeSats: 1500,
  });
  // The sign popup is the new page with Xverse's Confirm button; the helper
  // clicks it once it takes clicks and requires the popup to close.
  await approveXverseSignPopup({
    context,
    knownPages: knownPagesAtStart,
    label: 'Xverse mint sign popup',
    onScreenshot: (p) => shot(p, '02-sign-approval'),
  });
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
  const esploraTx = await waitForTxConfirmed(broadcastTxid);
  // eslint-disable-next-line no-console
  console.log(`[mint] locktime=${esploraTx.locktime}  block_hash=${esploraTx.status.block_hash}`);
  expect(esploraTx.locktime).toBe(21);
  // The cat LANDED: vout[0] pays the recipient ordinals address at 546.
  assertCatLandsAtRecipient(esploraTx, wallet.ordinalsAddress);
  expect(esploraTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(esploraTx);

  // Cat-sat guard: every input's sequence MUST be >= 0xfffffffe (RBF-
  // final). A lower value would let a fee-bump replacement drop the
  // nLockTime=21 marker and kill the mint (no cat is produced) — the
  // 2024 Xverse-Accelerate mint-RBF incident this test suite exists
  // to prevent.
  for (const vin of esploraTx.vin) {
    expect(vin.sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
  // Rule §11 assertion runs in test.afterEach via the context-level
  // errorGuard installed in beforeAll.
});
