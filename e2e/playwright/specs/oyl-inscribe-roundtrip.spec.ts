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

const EXT_PATH = path.resolve(__dirname, '../../extensions/oyl');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const FUND_AMOUNT_BTC = 0.001;
const INSCRIPTION_BODY_TEXT = 'oyl inscribed me on regtest';
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `oyl-inscribe-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

function utf8ToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function onboardOyl(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/tabs/index.html`, { waitUntil: 'domcontentloaded' });

  const importBtn = page.getByText('Import wallet', { exact: true });
  await expect(importBtn).toBeVisible({ timeout: 30_000 });
  await importBtn.click();

  const mnemonicInputs = page.locator('#word-0, #word-1, #word-2, #word-3, #word-4, #word-5, #word-6, #word-7, #word-8, #word-9, #word-10, #word-11');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await page.getByRole('button', { name: /^(import|continue|next|confirm)$/i }).first().click();

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  await pwInputs.nth(0).fill(TEST_PASSWORD);
  await pwInputs.nth(1).fill(TEST_PASSWORD);
  const termsLabel = page.locator('label').filter({ hasText: /Terms.*Privacy Policy/i }).first();
  await termsLabel.click();
  const pwContinue = page.getByRole('button', { name: /^(continue|create|finish|done)$/i }).first();
  try {
    await expect(pwContinue).toBeEnabled({ timeout: 10_000 });
  } catch {
    await termsLabel.click({ force: true }).catch(() => undefined);
    await page.evaluate(() => {
      const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (cb && !cb.checked) {
        cb.click();
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await expect(pwContinue).toBeEnabled({ timeout: 20_000 });
  }
  await pwContinue.click();

  await page.getByRole('button', { name: /^skip$/i }).click({ force: true });

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance');
  }, undefined, { timeout: 60_000, polling: 500 });
}

async function approveOylPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  try {
    const approval = await waitForApprovalPopup({
      context: ctx,
      knownPages,
      timeoutMs: 30_000,
      isApproval: async (p) => {
        if (!p.url().startsWith('chrome-extension://')) return false;
        await p.getByRole('button', { name: /^(connect|approve|confirm|allow|sign)$/i }).first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        return true;
      },
    });
    await shot(approval, 'approval');
    await approval.getByRole('button', { name: /^(connect|approve|confirm|allow|sign)$/i }).first().click();
  } catch {
    /* auto-resolved; nothing to click */
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Oyl extension not unpacked at ${EXT_PATH}.`);
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
  test.setTimeout(240_000);
  await onboardOyl(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('inscribe an artifact on regtest via Oyl: build commit+reveal in SDK, sign commit in popup, broadcast both via local electrs, verify via ordpool-parser', async () => {
  test.setTimeout(360_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOyl());
  await approveOylPopup(context, connectKnownPages);
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
    (args) => window.ordpoolSdkHarness.buildAndSignInscribeViaOyl(args),
    {
      utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
      paymentAddress: regtest.paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: regtest.ordinalsAddress,
      bodyHex: utf8ToHex(INSCRIPTION_BODY_TEXT),
      contentType: INSCRIPTION_CONTENT_TYPE,
      feeRatePerVbyte: 5,
    },
  );
  await approveOylPopup(context, signKnownPages);
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
