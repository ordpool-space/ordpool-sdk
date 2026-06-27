// Don't skip-or-delete — see the Xverse gold-standard pattern in
// /Work/ordpool/WALLETS.md. The full click-through is the source of
// truth that wallet onboarding still works; downstream specs may
// optionally cache a seeded user-data-dir for speed, but this file
// MUST stay green-or-loudly-failing on every CI run.

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

const EXT_PATH = path.resolve(__dirname, '../../extensions/oyl');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `oyl-onboard-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function dumpHtml(page: Page, name: string): Promise<void> {
  try {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 40_000));
    fs.writeFileSync(path.resolve(RESULTS_DIR, `oyl-onboard-${name}.html`), html);
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
});

test.afterAll(async () => {
  await context?.close();
});

test('restores a wallet from the BIP-39 test seed and reaches a screen mentioning send/receive/balance/account/bitcoin', async () => {
  test.setTimeout(180_000);

  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/tabs/index.html`, { waitUntil: 'domcontentloaded' });
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');

  // Oyl welcome shows "Welcome home! Let's setup your wallet." with
  // three cards: Create new wallet / Import wallet / Connect hardware
  // (Coming soon). Click the Import card.
  const importBtn = page.getByText('Import wallet', { exact: true });
  await expect(importBtn).toBeVisible({ timeout: 30_000 });
  await importBtn.click();
  await shot(page, '02-after-import-click');
  await dumpHtml(page, '02-after-import-click');

  // Step 03/05 — "Import your seed. Enter one by one!" — 12
  // `input[type="password"]` boxes with `id="word-0"` through
  // `id="word-11"`. Verified via CI 26580486080 dump.
  const mnemonicInputs = page.locator('#word-0, #word-1, #word-2, #word-3, #word-4, #word-5, #word-6, #word-7, #word-8, #word-9, #word-10, #word-11');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await shot(page, '04-mnemonic-filled');
  await dumpHtml(page, '04-mnemonic-filled');

  const confirmAfterMnemonic = page.getByRole('button', { name: /^(confirm|continue|next|import|restore)$/i }).first();
  await expect(confirmAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await confirmAfterMnemonic.click();
  await shot(page, '05-after-mnemonic-submit');

  // Step 04/05 — "Keep it secure! Set your password" with 2 password
  // fields + a required "I agree to the Terms & Privacy Policy"
  // checkbox. Continue stays disabled until the checkbox is ticked.
  // Page may render >2 password-type inputs if the wallet has Show
  // eye-toggle buttons rendered as type=password. Don't enforce
  // exact count; just fill the first two.
  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  await pwInputs.nth(0).fill(TEST_PASSWORD);
  await pwInputs.nth(1).fill(TEST_PASSWORD);
  await shot(page, '06-password-typed');

  // Terms checkbox: the actual <input type="checkbox"> is
  // aria-hidden + tabindex="-1" (CI 26597193687 error-context proved
  // this). React 16+ tracks `checked` via the prototype's native
  // setter, so a plain `cb.checked = true` is reverted on next
  // render; a synthetic label click was intermittently failing to
  // propagate the state transition. Use the native setter + input +
  // change events so React sees a real state transition.
  await page.evaluate(() => {
    const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (!cb) throw new Error('terms checkbox not found on the password screen');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    setter?.call(cb, true);
    cb.dispatchEvent(new Event('input', { bubbles: true }));
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await shot(page, '07-terms-checked');

  const pwContinue = page.getByRole('button', { name: /^(continue|create|finish|done)$/i }).first();
  await expect(pwContinue).toBeEnabled({ timeout: 15_000 });
  await pwContinue.click();
  await shot(page, '08-after-password-submit');

  // Step 05/05 — "Welcome home! Let's setup your account." profile
  // page. Click Skip with force to bypass profile setup. CI
  // 26675844132 captured the screen still visible after a regular
  // click, suggesting the regular click was absorbed somehow.
  const skipBtn = page.getByRole('button', { name: /^skip$/i });
  await expect(skipBtn).toBeVisible({ timeout: 15_000 });
  await skipBtn.click({ force: true });

  // Real dashboard markers only.
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance');
  }, undefined, { timeout: 60_000, polling: 500 });
  await shot(page, '08-dashboard');
  await dumpHtml(page, '08-dashboard');

  // eslint-disable-next-line no-console
  console.log('[oyl:onboard] dashboard rendered.');
});
