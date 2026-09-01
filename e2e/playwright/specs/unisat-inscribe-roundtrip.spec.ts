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
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { onboardUnisat } from '../onboard-unisat';

/**
 * Full inscribe roundtrip with the real Unisat extension. Same
 * network-agnostic-keys trick as `unisat-mint-roundtrip.spec.ts`:
 * Unisat ships only mainnet/signet/testnet, so we onboard it on
 * mainnet, fund the regtest-encoded address derived from the same
 * pubkey, and ask Unisat to sign a regtest-encoded PSBT (script
 * bytes are HRP-free).
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;

const INSCRIPTION_BODY_TEXT = 'unisat inscribed me on regtest';
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `unisat-inscribe-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

function utf8ToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
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

async function approveSignPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 90_000,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByTestId('sign-psbt-button')
        .waitFor({ state: 'visible', timeout: 90_000 });
      return true;
    },
  });
  await shot(approval, 'sign-approval');
  await approval.getByTestId('sign-psbt-button').click();
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Unisat extension not unpacked at ${EXT_PATH}.`);
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
  await onboardUnisat(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('inscribe an artifact on regtest via Unisat: build commit+reveal in SDK, sign commit in popup, broadcast both via local electrs, verify via ordpool-parser', async () => {
  test.setTimeout(360_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);

  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  expect(regtest.paymentAddress).toMatch(/^bcrt1q/);
  expect(regtest.ordinalsAddress).toMatch(/^bcrt1p/);
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', regtest.paymentAddress, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const utxo = await waitForUtxoAt(regtest.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  const signKnownPages = new Set(context.pages());
  const signedPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'inscribe' as const,
      walletType: 'unisat' as const,
      utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
      paymentAddress: regtest.paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: regtest.ordinalsAddress,
      bodyHex: utf8ToHex(INSCRIPTION_BODY_TEXT),
      contentType: INSCRIPTION_CONTENT_TYPE,
      feeRatePerVbyte: 5,
    },
  );
  await approveSignPopup(context, signKnownPages);
  const signed = await signedPromise;
  expect(signed.commitTxid).toMatch(/^[0-9a-f]{64}$/);
  expect(signed.revealTxid).toMatch(/^[0-9a-f]{64}$/);

  const commitTxid = await postTx(signed.commitHex);
  expect(commitTxid).toBe(signed.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(commitTxid);

  const revealTxid = await postTx(signed.revealHex);
  expect(revealTxid).toBe(signed.revealTxid);
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
