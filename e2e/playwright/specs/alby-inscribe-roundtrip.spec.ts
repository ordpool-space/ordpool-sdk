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
 * Account SEED goes via the LBE background-script router (Alby's
 * real onboarding needs an OAuth/NWC backend CI cannot provide);
 * SIGNING goes through the SHIPPING in-page path — alby.enable() +
 * alby.webbtc.signPsbt() with the real ConfirmSignPsbt popup,
 * auto-approved by the state-based handler.
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
  // Seeding done — signing uses the in-page provider, not this page.
  await seedPage.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('inscribe an artifact on regtest via Alby: build commit+reveal in SDK, sign commit in the REAL popup, broadcast both via local electrs, verify via ordpool-parser', async () => {
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

  // Build + sign via the SHIPPING path — the same runOperation route
  // every other wallet uses: createInscribeTransactions builds commit
  // + finalized reveal, then albySigner.signSingleFundingInput signs
  // the commit via alby.enable() + alby.webbtc.signPsbt() — the REAL
  // ConfirmSignPsbt popup, auto-approved by the handler above. Alby
  // returns wire-format raw commit hex.
  const built = await harness.evaluate((args) => window.ordpoolSdkHarness.runOperation(args), {
    kind: 'inscribe' as const,
    walletType: 'alby' as const,
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

  const commitTxid = await postTx(built.commitHex);
  // Non-witness-byte pin: broadcast txid == txid computed from the
  // unsigned commit, so Alby provably did not mutate non-witness bytes.
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
