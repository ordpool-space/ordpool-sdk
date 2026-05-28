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

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

let context: BrowserContext;
let extensionId: string;
let onboardPage: Page | null = null;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-onboard-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function dumpHtml(page: Page, name: string): Promise<void> {
  try {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 40_000));
    fs.writeFileSync(path.resolve(RESULTS_DIR, `alby-onboard-${name}.html`), html);
  } catch { /* ignore */ }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Alby extension not unpacked at ${EXT_PATH}.`);
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

  // Alby auto-opens its onboarding (options.html with the
  // "Set extension unlock passcode" screen) in a separate tab on
  // first install. CI 26597193687 confirmed via failure screenshot
  // (full-width 1280px viewport rather than our 400×800) — the page
  // we navigated to was a different one that auto-closed when Alby
  // took over. Capture the auto-opened page here.
  try {
    onboardPage = await context.waitForEvent('page', {
      predicate: p => p.url().startsWith(`chrome-extension://${extensionId}`),
      timeout: 15_000,
    });
  } catch { /* if not auto-opened, the test body will open one */ }
});

test.afterAll(async () => {
  await context?.close();
});

test('restores a wallet from the BIP-39 test seed and lands on the dashboard', async () => {
  test.setTimeout(180_000);

  // Prefer the auto-opened onboarding tab captured in beforeAll; fall
  // back to a manual navigation if Alby didn't auto-open one (e.g.
  // cached extension state).
  let page: Page;
  if (onboardPage) {
    page = onboardPage;
  } else {
    page = await context.newPage();
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  }
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');

  // Alby's first onboarding screen is "Set extension unlock passcode"
  // — two `input[type="password"]` fields (passcode + confirm) and a
  // "Next" button. Verified via CI 26580486080 test-failed-1.png.
  await expect(page.getByText('Set extension unlock passcode', { exact: false })).toBeVisible({ timeout: 30_000 });
  const passcodeInputs = page.locator('input[type="password"]');
  await expect(passcodeInputs.first()).toBeVisible({ timeout: 10_000 });
  await passcodeInputs.nth(0).fill(TEST_PASSWORD);
  await passcodeInputs.nth(1).fill(TEST_PASSWORD);
  await shot(page, '02-passcode-set');

  const passcodeNext = page.getByRole('button', { name: /^next$/i });
  await expect(passcodeNext).toBeEnabled({ timeout: 10_000 });
  await passcodeNext.click();
  await shot(page, '03-after-passcode-next');
  await dumpHtml(page, '03-after-passcode-next');

  // "Connect Alby Extension to a wallet" — TWO cards:
  //   - Alby Account → Continue with Alby Account (requires server)
  //   - Bring Your Own Wallet → Find Your Wallet (mnemonic flow)
  // CI 26602529964 dump confirmed exact text. Click the action button
  // on the BYOW card.
  const findWalletBtn = page.getByRole('button', { name: 'Find Your Wallet' });
  await expect(findWalletBtn).toBeVisible({ timeout: 20_000 });
  await findWalletBtn.click();
  await shot(page, '04-seed-route-picked');
  await dumpHtml(page, '04-seed-route-picked');

  // Mnemonic entry — likely a textarea or 12 boxes.
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
  await shot(page, '05-mnemonic-filled');

  const importBtn = page.getByRole('button', { name: /^(confirm|continue|next|import|restore|finish)$/i }).first();
  await expect(importBtn).toBeEnabled({ timeout: 15_000 });
  await importBtn.click();
  await shot(page, '06-after-mnemonic-submit');

  // Dashboard: balance / send / receive markers.
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('account');
  }, undefined, { timeout: 60_000, polling: 500 });
  await shot(page, '08-dashboard');
  await dumpHtml(page, '08-dashboard');

  // eslint-disable-next-line no-console
  console.log('[alby:onboard] dashboard rendered.');
});
