import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
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

import { installAlbyAutoApprove } from '../alby-auto-approve';
import { seedAlbyAccount } from '../onboard-alby';

/**
 * Full inscribe roundtrip with the real Alby Browser Extension.
 *
 * Same SW-message bypass as `alby-mint-roundtrip.spec.ts`: seed
 * Alby's account state directly via the LBE background-script
 * router, then sign the commit PSBT by calling the internal
 * `webbtc/signPsbt` route from an extension-origin page — bypassing
 * the React ConfirmSignPsbt popup whose confirm() never resolves in
 * headless CI.
 *
 * Alby's signPsbt is Taproot-only (`signTaprootInput` only); both
 * the inscribe funding input and the reveal recipient are P2TR on
 * the same key, which is exactly what Alby supports.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const EXPECTED_REGTEST_TAPROOT = 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg';

const FUND_AMOUNT_BTC = 0.001;
const INSCRIPTION_BODY_TEXT = 'alby inscribed me on regtest';
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;
let seedPage: Page;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-inscribe-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

function utf8ToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Alby extension not unpacked at ${EXT_PATH}.`);
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

  seedPage = await context.newPage();
  await seedPage.addInitScript(() => {
    try {
      Object.defineProperty(window, 'close', { value: () => undefined, writable: false, configurable: false });
    } catch { /* ignore */ }
    try {
      const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
      window.addEventListener('beforeunload', stop as unknown as EventListener, true);
    } catch { /* ignore */ }
  });
  await seedPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  await seedPage.waitForFunction(() => true, undefined, { timeout: 2_000 }).catch(() => undefined);
  test.setTimeout(240_000);

  await seedAlbyAccount(seedPage);
  await shot(seedPage, '00-after-seed').catch(() => undefined);
});

test.afterAll(async () => {
  await context?.close();
});

test('inscribe an artifact on regtest via Alby: build commit+reveal in SDK, sign commit via SW message, broadcast both via local electrs, verify via ordpool-parser', async () => {
  test.setTimeout(360_000);

  // Auto-click any extension popup so alby.enable() goes through.
  installAlbyAutoApprove(context);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const connectInfo = await harness.evaluate(async () => {
    interface WebBtcApi {
      enable?(): Promise<void>;
      getAddress(): Promise<{ address: string; publicKey: string } | string>;
    }
    interface AlbyApi {
      enable(): Promise<void>;
      webbtc: WebBtcApi;
    }
    const alby = (window as unknown as { alby: AlbyApi }).alby;
    await alby.enable();
    if (alby.webbtc.enable) await alby.webbtc.enable();
    const res = await alby.webbtc.getAddress();
    return typeof res === 'string'
      ? { address: res, publicKey: '' }
      : { address: res.address ?? '', publicKey: res.publicKey ?? '' };
  });
  expect(connectInfo.address).toBe(EXPECTED_REGTEST_TAPROOT);

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', connectInfo.address, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const utxo = await waitForUtxoAt(connectInfo.address, Math.round(FUND_AMOUNT_BTC * 1e8));

  // Build the commit + reveal via the SDK orchestrator. The reveal
  // is already finalized by the orchestrator; Alby only signs the
  // commit's funding input. The orchestrator returns the ephemeral
  // key on `built.ephemeralPrivKeyHex` so the spec can rebuild
  // alternate reveals if it wants (this happy-path test uses the
  // default reveal as-is).
  const built = await harness.evaluate((args) => {
    return window.ordpoolSdkHarness.buildInscribePsbtForAlby(args);
  }, {
    utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
    paymentAddress: connectInfo.address,
    paymentPublicKey: connectInfo.publicKey,
    recipientAddress: connectInfo.address,
    bodyHex: utf8ToHex(INSCRIPTION_BODY_TEXT),
    contentType: INSCRIPTION_CONTENT_TYPE,
    feeRatePerVbyte: 5,
  });
  expect(built.ephemeralPrivKeyHex).toMatch(/^[0-9a-f]{64}$/);
  expect(built.commitTxid).toMatch(/^[0-9a-f]{64}$/);
  expect(built.revealTxid).toMatch(/^[0-9a-f]{64}$/);

  // Sign the commit PSBT via Alby's internal SW route — the same
  // route mint uses. Returns wire-format raw tx hex.
  const signResult = await seedPage.evaluate(async (psbtHex) => {
    const c = (globalThis as unknown as { chrome: { runtime: {
      sendMessage: (msg: unknown) => Promise<unknown>;
    } } }).chrome;
    return await c.runtime.sendMessage({
      application: 'LBE',
      prompt: true,
      action: 'webbtc/signPsbt',
      args: { psbt: psbtHex },
      origin: { internal: true },
    }) as { data?: { signed: string }; error?: string };
  }, built.commitPsbtHex);
  if (signResult.error || !signResult.data?.signed) {
    throw new Error(`Alby webbtc/signPsbt failed: ${JSON.stringify(signResult)}`);
  }
  const commitHex = signResult.data.signed;

  const commitTxid = await postTx(commitHex);
  expect(commitTxid).toBe(built.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(commitTxid);

  const revealTxid = await postTx(built.revealHex);
  expect(revealTxid).toBe(built.revealTxid);
  await waitForElectrsSync(mineBlocks(1));
  const revealTx = await waitForTxConfirmed(revealTxid);
  expect(revealTx.status.block_hash).toBeTruthy();

  const witnessHex = (revealTx as unknown as { vin: { witness: string[] }[] }).vin[0].witness;
  const parsed = InscriptionParserService.parse({ txid: revealTxid, vin: [{ witness: witnessHex }] });
  expect(parsed.length).toBe(1);
  expect(parsed[0].contentType).toBe(INSCRIPTION_CONTENT_TYPE);
  const recovered = new TextDecoder().decode(parsed[0].getDataRaw());
  expect(recovered).toBe(INSCRIPTION_BODY_TEXT);
});
