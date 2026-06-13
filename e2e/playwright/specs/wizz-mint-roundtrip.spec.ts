import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { getUtxos, waitForElectrsSync, rpc, mineBlocks, getTx, postTx, assertAllInputsSighashAll } from '../../regtest/regtest-helpers';
import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 5 — full cat21 mint roundtrip with the real Wizz
 * extension. Wizz is a Unisat fork; the single-address pattern
 * mirrors unisat-mint-roundtrip exactly. Wizz only ships mainnet/
 * testnet networks, so the cross-network-keys trick from Unisat
 * applies: we sign a regtest-encoded PSBT against the wallet's
 * mainnet address (the P2WPKH script hash is HRP-independent).
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/wizz');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `wizz-mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
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
  // Wizz inherits Unisat's connect-approval shape — Connect is a styled div.
  await approval.getByText(/^Connect$/).first().click();
}

async function approveSignPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  // URL-anchor on Wizz's standard approval path (#/approval/SignPsbt)
  // — same URL pattern as the connect approval that wizz-sdk-handshake
  // matches. Sourced from background.js APPROVAL annotations:
  // signPsbt → "SignPsbt" approval route.
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    timeoutMs: 120_000,
    isApproval: async (p) => {
      await p.waitForURL(/notification\.html#\/approval/, { timeout: 120_000 });
      return true;
    },
  });
  await shot(approval, '03a-sign-approval');
  // Sign button is initially disabled (Wizz analyses the PSBT first).
  // The disabled state covers it with a spinner overlay; textContent
  // can include whitespace + spinner chars so we can't pin on
  // exact-text. Wait for the button's pointer-events to enable AND
  // for the click to actually land — do both inside page.evaluate to
  // avoid the textContent-matching race in the outer Playwright
  // locator.
  const clicked = await approval.waitForFunction(() => {
    const isSignButton = (el: Element) => {
      const text = (el.textContent || '').trim();
      // Loose match — accept "Sign" optionally surrounded by spinner
      // chars or whitespace, but reject elsewhere texts like "Signed".
      return /^\s*[⠀-⣿•●]?\s*Sign\s*$/i.test(text);
    };
    const els = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], div'));
    const candidate = els.find(isSignButton);
    if (!candidate) return null;
    const style = getComputedStyle(candidate);
    if (style.pointerEvents === 'none') return null;
    if (parseFloat(style.opacity) < 0.7) return null;
    candidate.click();
    return { text: candidate.textContent };
  }, undefined, { timeout: 60_000, polling: 250 });
  // The popup auto-closes after Wizz processes the click; jsonValue
  // would race against the page-closed condition. Wrap defensively.
  // eslint-disable-next-line no-console
  console.log('[wizz-mint] clicked sign-button (popup may have closed)');
  void clicked;
  await shot(approval, '03b-after-sign-click').catch(() => undefined);
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

  // Wizz fans out to configs.wizz.cash on mount — CI has no outbound
  // internet so the fetch hangs. Abort at the browser layer.
  await context.route('**/configs.wizz.cash/**', route => route.abort());

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  const onboardPage = await context.newPage();
  test.setTimeout(180_000);
  await onboardWizz(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

// Re-attempting after source-diving the v2.13.4 binary. Wizz's signPsbt
// has the same P() validator as Unisat (Psbt.fromHex must not throw)
// — verified at background.js byte 2244000. The approval route is
// notification.html#/approval/SignPsbt. The iter 35-36 failures were
// likely matcher misses, not silent wallet rejects. Anchor on the URL
// (same pattern as wizz-sdk-handshake) and click "Sign".
test('mint a cat21 on regtest via Wizz: build PSBT in SDK, sign in popup (mainnet wallet, regtest PSBT), broadcast via local electrs', async () => {
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
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectWizz());
  await approveConnectPopup(context, connectKnownPages);
  const wallet = await connectResultPromise;
  console.log(`[wizz-mint] mainnet payment = ${wallet.paymentAddress}`);
  expect(wallet.paymentAddress).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');

  const regtest = await harness.evaluate(
    (pk: string) => window.ordpoolSdkHarness.deriveRegtestAddresses(pk),
    wallet.paymentPublicKey,
  );
  console.log(`[wizz-mint] regtest payment = ${regtest.paymentAddress}`);
  console.log(`[wizz-mint] regtest ordinals = ${regtest.ordinalsAddress}`);
  expect(regtest.paymentAddress).toMatch(/^bcrt1q/);
  expect(regtest.ordinalsAddress).toMatch(/^bcrt1p/);

  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', regtest.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  console.log(`[wizz-mint] funded ${regtest.paymentAddress} with ${FUND_AMOUNT_BTC} BTC in tx ${fundTxid}`);
  const newTip = mineBlocks(1);
  await waitForElectrsSync(newTip);

  // Tip sync via waitForElectrsSync says the block is indexed, but
  // address-history endpoints occasionally lag behind by a poll
  // interval. Retry the UTXO lookup with a short backoff before giving
  // up — race observed in iter 45.
  const utxoDeadline = Date.now() + 30_000;
  let utxo;
  while (Date.now() < utxoDeadline) {
    const utxos = await getUtxos(regtest.paymentAddress);
    utxo = utxos.find(u => u.value === Math.round(FUND_AMOUNT_BTC * 1e8));
    if (utxo) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!utxo) throw new Error(`could not find ${FUND_AMOUNT_BTC} BTC UTXO at ${regtest.paymentAddress} within 30s`);
  console.log(`[wizz-mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  const signKnownPages = new Set(context.pages());
  const signedHexPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.buildAndSignMintViaWizz(args),
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
  console.log(`[wizz-mint] signed tx hex (${signed.txHex.length} chars), broadcasting via local electrs…`);

  const broadcastTxid = await postTx(signed.txHex);
  console.log(`[wizz-mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await getTx(broadcastTxid);
  console.log(`[wizz-mint] locktime=${esploraTx.locktime}  block_hash=${esploraTx.status.block_hash}`);
  expect(esploraTx.locktime).toBe(21);
  expect(esploraTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(esploraTx);

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
