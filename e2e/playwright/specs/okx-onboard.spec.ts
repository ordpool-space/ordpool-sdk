import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 2 of the OKX E2E pipeline: restore from the BIP-39 test
 * seed and confirm the dashboard renders. First-pass speculation —
 * OKX is a multi-chain wallet but the Bitcoin restore flow follows
 * the standard import → password → mnemonic → dashboard shape. CI
 * artifacts will dial in the exact selectors.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/okx');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

let context: BrowserContext;
let extensionId: string;
let onboardPage: Page | null = null;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `okx-onboard-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function dumpHtml(page: Page, name: string): Promise<void> {
  try {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 40_000));
    fs.writeFileSync(path.resolve(RESULTS_DIR, `okx-onboard-${name}.html`), html);
  } catch { /* ignore */ }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`OKX extension not unpacked at ${EXT_PATH}.`);
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

  // OKX auto-opens its onboarding in a separate tab on install
  // (CI 26597193687 confirmed: page reference closed mid-test;
  // sibling marketing tab was open at https://www.okx.com/...).
  // The chrome-extension://<id>/* tab is the real onboarding; ignore
  // the marketing tab via the URL filter.
  try {
    onboardPage = await context.waitForEvent('page', {
      predicate: p => p.url().startsWith(`chrome-extension://${extensionId}`),
      timeout: 15_000,
    });
  } catch { /* fall back to manual newPage in test body */ }
});

test.afterAll(async () => {
  await context?.close();
});

test('restores a wallet from the BIP-39 test seed and lands on the dashboard', async () => {
  test.setTimeout(180_000);

  let page: Page;
  if (onboardPage) {
    page = onboardPage;
  } else {
    page = await context.newPage();
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/popup-init.html`, { waitUntil: 'domcontentloaded' });
  }
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');

  // OKX onboarding (auto-opened tab caught in beforeAll): welcome
  // is "Your portal to Web3" with "Create wallet" / "Import wallet"
  // buttons (CI 26602529964 dump). getByText hit a non-actionable
  // element; switch to the button role.
  const importBtn = page.getByRole('button', { name: 'Import wallet' });
  await expect(importBtn).toBeVisible({ timeout: 30_000 });
  // CI 26604643877 showed the screen unchanged after the click —
  // OKX's React handlers aren't bound yet at the moment of the
  // actionability check, so the synthetic click is silently dropped.
  // force:true dispatches the click regardless; the page re-renders
  // once React finishes hydration.
  await importBtn.click({ force: true });
  await shot(page, '02-after-import-click');
  await dumpHtml(page, '02-after-import-click');

  // Pick "Seed phrase or private key" — hard-assert visibility so a
  // UI change is caught instead of silently skipped.
  const seedOption = page.getByText('Seed phrase or private key', { exact: true });
  await expect(seedOption).toBeVisible({ timeout: 15_000 });
  await seedOption.click();
  await shot(page, '03-seed-option-picked');

  // Mnemonic entry: 12 boxes or one textarea.
  const mnemonicInputs = page.locator('input[type="text"], input[type="password"], textarea');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  const inputCount = await mnemonicInputs.count();
  if (inputCount >= 12) {
    for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
      await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
    }
  } else {
    await mnemonicInputs.first().fill(TEST_MNEMONIC);
  }
  await shot(page, '04-mnemonic-filled');
  await dumpHtml(page, '04-mnemonic-filled');

  const confirmAfterMnemonic = page.getByRole('button', { name: /^(confirm|continue|next|import|restore)$/i }).first();
  await expect(confirmAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await confirmAfterMnemonic.click();
  await shot(page, '05-after-mnemonic-submit');

  // Password setup (may be 1 or 2 fields).
  const pwInputs = page.locator('input[type="password"]');
  if (await pwInputs.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
    const pwCount = await pwInputs.count();
    for (let i = 0; i < pwCount; i++) {
      await pwInputs.nth(i).fill(TEST_PASSWORD);
    }
    await shot(page, '06-password-typed');
    const pwContinue = page.getByRole('button', { name: /^(confirm|continue|next|create|done)$/i }).first();
    await expect(pwContinue).toBeEnabled({ timeout: 10_000 });
    await pwContinue.click();
    await shot(page, '07-after-password-submit');
  }

  // Dashboard: balance / send / receive markers.
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('account');
  }, undefined, { timeout: 60_000, polling: 500 });
  await shot(page, '08-dashboard');
  await dumpHtml(page, '08-dashboard');

  // eslint-disable-next-line no-console
  console.log('[okx:onboard] dashboard rendered.');
});
