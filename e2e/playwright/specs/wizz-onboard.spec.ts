import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 2 of the Wizz E2E pipeline: drive the onboarding flow
 * from the BIP-39 test seed.
 *
 * Wizz is a Unisat fork but strips all `data-testid` attributes
 * from its build — `grep -c data-testid` on the bundled ui.js
 * returns zero. Selectors are therefore text-based; if Wizz
 * relabels any UI string the test will need a new iteration.
 *
 * Welcome-screen text confirmed via CI 26413060518 screenshot:
 *   "Create new wallet" / "I already have a wallet"
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/wizz');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `wizz-onboard-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function dumpHtml(page: Page, name: string): Promise<void> {
  try {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 8000));
    fs.writeFileSync(path.resolve(RESULTS_DIR, `wizz-onboard-${name}.html`), html);
  } catch {
    // ignore
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Wizz extension not unpacked at ${EXT_PATH}.`);
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

test('restores a wallet from the BIP-39 test seed and lands on the dashboard', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  // ─── Phase 1: welcome screen ───
  await expect(page.getByText('I already have a wallet', { exact: true })).toBeVisible({ timeout: 30_000 });
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');

  // ─── Phase 2: "I already have a wallet" ───
  await page.getByText('I already have a wallet', { exact: true }).click();
  await shot(page, '02-after-import-click');
  await dumpHtml(page, '02-after-import-click');

  // ─── Phase 3: "Create a password" (Wizz inherits Unisat's
  //              password-before-mnemonic order; verified via CI
  //              26413717806 screenshot 02-after-import-click.png) ───
  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  // Two fields: Password + Confirm Password. Fill both with the
  // same value so the Continue button enables.
  const pwCount = await pwInputs.count();
  for (let i = 0; i < pwCount; i++) {
    await pwInputs.nth(i).fill(TEST_PASSWORD);
  }
  await shot(page, '03-password-typed');

  const pwContinue = page.getByRole('button', { name: /^continue$/i }).first();
  await expect(pwContinue).toBeEnabled({ timeout: 10_000 });
  await pwContinue.click();
  await shot(page, '04-after-password-submit');
  await dumpHtml(page, '04-after-password-submit');

  // ─── Phase 4: source-wallet picker ───
  // Unisat-style "Choose a wallet to restore from" with Wizz/Atom
  // at the top of the list. The list is rendered as tappable rows
  // that include the wallet name as text; click the row whose
  // text starts with "Wizz" (most likely first option).
  const sourceWizz = page.getByText(/wizz wallet/i).first();
  await expect(sourceWizz).toBeVisible({ timeout: 10_000 });
  await sourceWizz.click();
  await shot(page, '05-source-wallet-picked');
  await dumpHtml(page, '05-source-wallet-picked');

  // ─── Phase 5: mnemonic entry ───
  // Probably 12 per-word inputs (Unisat-style grid).
  await page.waitForTimeout(500);
  const mnemonicInputs = page.locator('input[type="text"], input[type="password"]');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  const mnemonicCount = await mnemonicInputs.count();
  if (mnemonicCount >= 12) {
    for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
      await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
    }
  } else {
    const textarea = page.locator('textarea').first();
    if (await textarea.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await textarea.fill(TEST_MNEMONIC);
    } else {
      throw new Error(`Mnemonic input shape not recognized — got ${mnemonicCount} input(s), no textarea`);
    }
  }
  await shot(page, '06-mnemonic-filled');

  const mnemonicContinue = page.getByRole('button', { name: /^continue$/i }).first();
  await expect(mnemonicContinue).toBeEnabled({ timeout: 10_000 });
  await mnemonicContinue.click();
  await shot(page, '07-after-mnemonic-continue');
  await dumpHtml(page, '07-after-mnemonic-continue');

  // ─── Phase 6: address-type screen (optional) ───
  // Wizz may show the same "Native SegWit" / "Taproot" picker as
  // Unisat. Click Continue if present; otherwise skip.
  const addressTypeContinue = page.getByRole('button', { name: /^continue$/i }).first();
  if (await addressTypeContinue.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await addressTypeContinue.click().catch(() => undefined);
    await shot(page, '08-after-address-type');
  }

  // ─── Phase 7: dashboard ───
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('receive') || t.includes('send') || t.includes('balance') || t.includes('account');
  }, undefined, { timeout: 30_000, polling: 250 });
  await shot(page, '09-dashboard');

  // eslint-disable-next-line no-console
  console.log(`[wizz:onboard] dashboard rendered — wallet committed.`);
});
