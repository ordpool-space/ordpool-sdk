import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { getUtxos, waitForElectrsSync, rpc, mineBlocks, getTx, postTx } from '../../regtest/regtest-helpers';
import { waitForApprovalPopup } from '../approval-popup';
import { onboardPhantom } from '../onboard-phantom';

/**
 * Iteration 5 — full cat21 mint roundtrip with the real Phantom
 * extension. Phantom is multi-chain; the BTC sub-provider speaks
 * JSON-RPC via `phantom.bitcoin.request({method:"btc_signPSBT",
 * params:[bytes, {inputsToSign, finalize:false}]})`.
 *
 * Dual-address contract: payment = BIP-84 P2WPKH, ordinals =
 * BIP-86 P2TR. Cross-network-keys trick applies as with Unisat —
 * Phantom only ships mainnet, so we sign a regtest-encoded PSBT
 * against the mainnet wallet (the P2WPKH script hash matches).
 *
 * Phantom's onboarding leaves the wallet on "You're good to go!"
 * which can't be advanced via automation. We navigate the onboard
 * tab to popup.html to leave that screen and land on the dashboard,
 * which IS the state where dApp connect requests trigger approval
 * popups.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/phantom');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `phantom-mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function approveGeneric(ctx: BrowserContext, knownPages: Set<Page>, timeoutMs = 60_000): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByRole('button', { name: /^(connect|approve|confirm|allow|sign)$/i }).first()
        .waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    },
  });
  await approval.getByRole('button', { name: /^(connect|approve|confirm|allow|sign)$/i }).first().click();
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Phantom extension not unpacked at ${EXT_PATH}.`);
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

  let onboardPage: Page;
  try {
    onboardPage = await context.waitForEvent('page', {
      predicate: p => p.url().startsWith(`chrome-extension://${extensionId}`),
      timeout: 15_000,
    });
  } catch {
    onboardPage = await context.newPage();
  }
  test.setTimeout(240_000);
  await onboardPhantom(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded');
  // Bypass "You're good to go!" by writing the storage key Phantom
  // reads to decide first-time-onboarding state.
  await worker.evaluate(() => {
    return new Promise<void>((resolve) => {
      const c = (globalThis as unknown as { chrome: { storage: { local: { set: (d: Record<string, unknown>, cb: () => void) => void } } } }).chrome;
      c.storage.local.set({ firstTimeOnboarding: { isFirstTimeOnboarding: false } }, () => resolve());
    });
  });
  await shot(onboardPage, '00b-after-storage-bypass');
});

test.afterAll(async () => {
  await context?.close();
});

// Reactivated alongside phantom-sdk-handshake: the storage-bypass for
// firstTimeOnboarding unblocks dApp connect requests.
test('mint a cat21 on regtest via Phantom: build PSBT in SDK, sign in Phantom popup, broadcast via local electrs', async () => {
  test.setTimeout(300_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectPhantom());
  await approveGeneric(context, connectKnownPages, 60_000);
  const wallet = await connectResultPromise;
  console.log(`[phantom-mint] payment = ${wallet.paymentAddress}`);
  console.log(`[phantom-mint] ordinals = ${wallet.ordinalsAddress}`);
  expect(wallet.paymentAddress).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  expect(wallet.ordinalsAddress).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');

  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  console.log(`[phantom-mint] regtest payment = ${regtest.paymentAddress}`);
  console.log(`[phantom-mint] regtest ordinals = ${regtest.ordinalsAddress}`);

  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', regtest.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  console.log(`[phantom-mint] funded ${regtest.paymentAddress} with ${FUND_AMOUNT_BTC} BTC in tx ${fundTxid}`);
  const newTip = mineBlocks(1);
  await waitForElectrsSync(newTip);

  const utxos = await getUtxos(regtest.paymentAddress);
  const utxo = utxos.find(u => u.value === Math.round(FUND_AMOUNT_BTC * 1e8));
  if (!utxo) throw new Error(`could not find ${FUND_AMOUNT_BTC} BTC UTXO at ${regtest.paymentAddress}`);
  console.log(`[phantom-mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  const signKnownPages = new Set(context.pages());
  const signedHexPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.buildAndSignMintViaPhantom(args),
    {
      utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
      paymentAddress: regtest.paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: regtest.ordinalsAddress,
      feeSats: 1500,
    },
  );
  await approveGeneric(context, signKnownPages, 90_000);
  const signed = await signedHexPromise;
  console.log(`[phantom-mint] signed tx hex (${signed.txHex.length} chars), broadcasting via local electrs…`);

  const broadcastTxid = await postTx(signed.txHex);
  console.log(`[phantom-mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await getTx(broadcastTxid);
  console.log(`[phantom-mint] locktime=${esploraTx.locktime}`);
  expect(esploraTx.locktime).toBe(21);

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
