import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 3 of the OKX E2E pipeline: SDK ↔ OKX handshake.
 *
 * OKX is a multi-chain wallet but the Bitcoin path follows a
 * single-address-per-wallet contract (like Unisat / Wizz). The SDK
 * connector populates both paymentAddress and ordinalsAddress from
 * the same Bitcoin address; we assert the BIP-84 derivation for the
 * abandon-seed.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const EXPECTED_PAYMENT_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `okx-handshake-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardOkx(page: Page): Promise<void> {
  // page may already be the auto-opened onboarding tab.
  if (page.url() === 'about:blank') {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/popup-init.html`, { waitUntil: 'domcontentloaded' });
  }

  await page.waitForFunction(() => {
    const wrapper = document.querySelector('[class*="_affix_"]') as HTMLElement | null;
    return !!wrapper && getComputedStyle(wrapper).opacity === '1';
  }, undefined, { timeout: 60_000, polling: 250 });
  const importBtn = page.getByTestId('onboard-page-import-wallet-button');
  await expect(importBtn).toBeVisible({ timeout: 10_000 });
  const cdp = await page.context().newCDPSession(page);
  const box = await importBtn.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 20, y: y - 20, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 5, y: y - 5, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
  await importBtn.click({ force: true, delay: 100 }).catch(() => undefined);
  const stillOnWelcome = await page.locator('text="Your portal to Web3"')
    .isVisible({ timeout: 3_000 }).catch(() => false);
  if (stillOnWelcome) {
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="onboard-page-import-wallet-button"]') as HTMLElement | null;
      btn?.click();
    });
  }

  const seedOption = page.getByText('Seed phrase or private key', { exact: true });
  await expect(seedOption).toBeVisible({ timeout: 15_000 });
  const seedBox = await seedOption.boundingBox();
  if (seedBox) {
    const x = seedBox.x + seedBox.width / 2;
    const y = seedBox.y + seedBox.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // OKX renders the seed-phrase form inside #ui-ses-iframe-container.
  const seedFrame = page.frameLocator('#ui-ses-iframe');
  await expect(seedFrame.locator('text="My seed phrase has"').first())
    .toBeVisible({ timeout: 30_000 });

  const mnemonicInputs = seedFrame.locator('input');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  const inputCount = await mnemonicInputs.count();
  if (inputCount >= 12) {
    for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
      await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
    }
  } else {
    await mnemonicInputs.first().fill(TEST_MNEMONIC);
  }

  const confirmAfterMnemonic = seedFrame.getByRole('button', { name: /^(confirm|continue|next|import|restore)$/i }).first();
  await expect(confirmAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await confirmAfterMnemonic.click();

  // "Secure your wallet" step: Password preselected, click Next.
  const secureHeader = page.locator('text="Secure your wallet"').first();
  if (await secureHeader.isVisible({ timeout: 10_000 }).catch(() => false)) {
    const nextBtn = page.getByRole('button', { name: /^next$/i }).first();
    await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
    await nextBtn.click();
  }

  const pwInputs = seedFrame.locator('input[type="password"]');
  if (await pwInputs.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
    const pwCount = await pwInputs.count();
    for (let i = 0; i < pwCount; i++) {
      await pwInputs.nth(i).fill(TEST_PASSWORD);
    }
    const pwContinue = seedFrame.getByRole('button', { name: /^(confirm|continue|next|create|done)$/i }).first();
    await expect(pwContinue).toBeEnabled({ timeout: 10_000 });
    await pwContinue.click();
  }

  await page.waitForFunction(() => {
    const collect = (root: Document) => (root.body?.innerText || '').toLowerCase();
    let t = collect(document);
    const f = document.querySelector('#ui-ses-iframe') as HTMLIFrameElement | null;
    if (f?.contentDocument) t += ' ' + collect(f.contentDocument);
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('total');
  }, undefined, { timeout: 60_000, polling: 500 });
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`OKX extension not unpacked at ${EXT_PATH}.`);
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
      // OKX anti-automation: hide navigator.webdriver.
      '--disable-blink-features=AutomationControlled',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  // Prefer the auto-opened chrome-extension onboarding tab; fall back
  // to manual newPage if OKX didn't auto-open one.
  let onboardPage: Page;
  try {
    onboardPage = await context.waitForEvent('page', {
      predicate: p => p.url().startsWith(`chrome-extension://${extensionId}`),
      timeout: 15_000,
    });
  } catch {
    onboardPage = await context.newPage();
  }
  test.setTimeout(180_000);
  await onboardOkx(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('okxConnector.connect via the harness page returns the BIP-84 mainnet address for the test seed', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  const knownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectOkx());
  resultPromise.catch(() => undefined);

  // OKX's approval surface — try URL-anchor first, then fall back to
  // a generic "Connect/Approve" button on any new chrome-extension page.
  const approval = await waitForApprovalPopup({
    context,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first()
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await shot(approval, '01-approval');
  await approval.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first().click();

  const info = await resultPromise;
  // eslint-disable-next-line no-console
  console.log(`[okx:sdk-handshake] paymentAddress = ${info.paymentAddress}`);

  expect(info.signingSupported).toBe(true);
  expect(info.paymentAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  // OKX single-address contract: ordinalsAddress mirrors payment.
  expect(info.ordinalsAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
});
