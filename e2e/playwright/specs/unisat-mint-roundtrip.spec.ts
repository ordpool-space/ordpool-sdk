import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { getUtxos, waitForElectrsSync, rpc, mineBlocks, getTx, postTx } from '../../regtest/regtest-helpers';

/**
 * Iteration 4 — full cat21 mint roundtrip with the real Unisat
 * extension. Combines Pipeline B's wallet (Playwright + Unisat) with
 * the regtest stack (bitcoind + electrs on localhost).
 *
 * Unisat v1.7.15 doesn't ship a regtest network — only mainnet /
 * signet / testnet appear in its chain enum. We work around it via
 * the network-agnostic-keys trick:
 *
 *  - Unisat is onboarded on MAINNET. The wallet derives a bc1q
 *    payment address from the BIP-39 test seed.
 *  - Our harness re-derives the SAME pubkey's bcrt1q + bcrt1p
 *    addresses (regtest HRP) via @scure/btc-signer. These are
 *    structurally identical scripts to the mainnet ones; only the
 *    bech32 HRP differs.
 *  - We fund the bcrt1q address on regtest via bitcoind RPC,
 *    build a CAT-21 PSBT using Network.Regtest, and ask Unisat
 *    to signPsbt(hex, {autoFinalized: true}).
 *  - Unisat's `formatOptionsToSignInputs` (verified via grep of
 *    background.js v1.7.15) decodes each input's scriptPubKey USING
 *    THE WALLET'S OWN networkType (mainnet) and compares to
 *    this.address. The script bytes carry no HRP info, so the
 *    derived address comes out as bc1q... — matching the wallet's
 *    bc1q address. Signing succeeds.
 *  - We broadcast the signed hex via local electrs (skipping
 *    Unisat's vendor-backend pushPsbt entirely).
 *  - Mine 1 block, fetch via electrs, parse as cat21.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

// In regtest 1 BTC = 100M sats; fund with 0.001 BTC so the mint
// has plenty of headroom plus a meaningful change output.
const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `unisat-mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardUnisat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('welcome-title')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('import-wallet-button').click();

  await expect(page.getByTestId('create-password-input')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-confirm-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-continue-button').click();

  await expect(page.getByTestId('restore-wallet-type-option-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('restore-wallet-type-option-0').click();

  await expect(page.getByTestId('mnemonic-import-word-0')).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await page.getByTestId(`mnemonic-import-word-${i}`).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await page.getByTestId('mnemonic-import-continue-button').click();

  const addressTypeContinue = page.getByTestId('address-type-continue-button');
  if (await addressTypeContinue.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await addressTypeContinue.click();
  }

  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (await noticeCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await noticeCheckbox.click();
    const noticeOk = page.getByTestId('notice-ok-button');
    if (await noticeOk.isEnabled({ timeout: 3_000 }).catch(() => false)) {
      await noticeOk.click();
    }
  }

  await expect(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const deadline = Date.now() + 60_000;
  let approval: Page | undefined;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if (knownPages.has(p)) continue;
      if (!p.url().startsWith('chrome-extension://')) continue;
      const txt = await p.locator('body').innerText().catch(() => '');
      if (/connect|approve|confirm|allow/i.test(txt)) {
        approval = p;
        break;
      }
    }
    if (approval) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!approval) throw new Error('unisat connection-request popup never appeared');
  // Unisat uses styled div, not <button> — match by text.
  await approval.getByText(/^Connect$/).first().click();
}

async function approveSignPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const deadline = Date.now() + 90_000;
  let approval: Page | undefined;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if (knownPages.has(p)) continue;
      if (!p.url().startsWith('chrome-extension://')) continue;
      // Sign approval has the sign-psbt-button testid per the bundle.
      if (await p.getByTestId('sign-psbt-button').isVisible({ timeout: 200 }).catch(() => false)) {
        approval = p;
        break;
      }
    }
    if (approval) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!approval) throw new Error('unisat sign-PSBT popup never appeared');
  await shot(approval, '03a-sign-approval');
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
  await onboardUnisat(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('mint a cat21 on regtest via Unisat: build PSBT in SDK, sign in popup (mainnet wallet, regtest PSBT), broadcast via local electrs', async () => {
  test.setTimeout(300_000);

  // ─── Connect via SDK harness, get mainnet pubkey ────────────────
  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  // eslint-disable-next-line no-console
  console.log(`[unisat-mint] mainnet payment = ${wallet.paymentAddress}`);
  expect(wallet.paymentAddress).toMatch(/^bc1q/);

  // ─── Derive the regtest address from the same pubkey ───────────
  // Unisat doesn't ship regtest; we synthesize the bcrt1q address
  // ourselves in the harness via @scure/btc-signer.p2wpkh on the
  // regtest network. Same script hash, different HRP.
  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  // eslint-disable-next-line no-console
  console.log(`[unisat-mint] regtest payment = ${regtest.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[unisat-mint] regtest ordinals = ${regtest.ordinalsAddress}`);
  expect(regtest.paymentAddress).toMatch(/^bcrt1q/);
  expect(regtest.ordinalsAddress).toMatch(/^bcrt1p/);

  // ─── Fund the bcrt1q address from bitcoind ─────────────────────
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', regtest.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  // eslint-disable-next-line no-console
  console.log(`[unisat-mint] funded ${regtest.paymentAddress} with ${FUND_AMOUNT_BTC} BTC in tx ${fundTxid}`);
  const newTip = mineBlocks(1);
  await waitForElectrsSync(newTip);

  const utxos = await getUtxos(regtest.paymentAddress);
  expect(utxos.length).toBeGreaterThan(0);
  const utxo = utxos.find(u => u.value === Math.round(FUND_AMOUNT_BTC * 1e8));
  if (!utxo) throw new Error(`could not find ${FUND_AMOUNT_BTC} BTC UTXO at ${regtest.paymentAddress}; got ${JSON.stringify(utxos)}`);
  // eslint-disable-next-line no-console
  console.log(`[unisat-mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  // ─── Build + sign mint PSBT via SDK + Unisat popup ─────────────
  const signKnownPages = new Set(context.pages());
  const signedHexPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.buildAndSignMintViaUnisat(args),
    {
      utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
      paymentAddress: regtest.paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: regtest.ordinalsAddress,
      feeSats: 1500,
    },
  );
  await approveSignPopup(context, signKnownPages);
  const signed = await signedHexPromise;
  // eslint-disable-next-line no-console
  console.log(`[unisat-mint] signed tx hex (${signed.txHex.length} chars), broadcasting via local electrs…`);

  // ─── Broadcast via local electrs ───────────────────────────────
  const broadcastTxid = await postTx(signed.txHex);
  // eslint-disable-next-line no-console
  console.log(`[unisat-mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  // ─── Confirm + verify via parser ───────────────────────────────
  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await getTx(broadcastTxid);
  // eslint-disable-next-line no-console
  console.log(`[unisat-mint] locktime=${esploraTx.locktime}  block_hash=${esploraTx.status.block_hash}`);
  expect(esploraTx.locktime).toBe(21);
  expect(esploraTx.status.block_hash).toBeTruthy();

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
