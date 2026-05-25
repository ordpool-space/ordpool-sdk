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

  // ─── Phase 3: mnemonic entry ───
  // Wizz's fork inherits Unisat's 12-input mnemonic grid OR
  // a single textarea. First attempt: try per-word inputs by
  // typing each word into the next available text/password
  // input. Falls back to a textarea if only one is present.
  await page.waitForTimeout(800);
  await dumpHtml(page, '03-mnemonic-screen');

  const inputs = page.locator('input[type="text"], input[type="password"]');
  await expect(inputs.first()).toBeVisible({ timeout: 15_000 });
  const count = await inputs.count();
  if (count >= 12) {
    for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
      await inputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
    }
  } else {
    // Single textarea — paste the whole phrase.
    const textarea = page.locator('textarea').first();
    if (await textarea.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await textarea.fill(TEST_MNEMONIC);
    } else {
      throw new Error(`Mnemonic input shape not recognized — got ${count} input(s), no textarea`);
    }
  }
  await shot(page, '04-mnemonic-filled');

  // Continue — try common labels.
  const mnemonicContinue = page.getByRole('button', { name: /continue|next|import|restore/i }).first();
  await expect(mnemonicContinue).toBeVisible({ timeout: 10_000 });
  await mnemonicContinue.click();
  await shot(page, '05-after-mnemonic-continue');
  await dumpHtml(page, '05-after-mnemonic-continue');

  // ─── Phase 4: password screen ───
  // Probably two input[type=password] fields.
  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  const pwCount = await pwInputs.count();
  for (let i = 0; i < pwCount; i++) {
    await pwInputs.nth(i).fill(TEST_PASSWORD);
  }
  await shot(page, '06-password-typed');

  const pwContinue = page.getByRole('button', { name: /continue|next|create|confirm/i }).first();
  await expect(pwContinue).toBeEnabled({ timeout: 10_000 });
  await pwContinue.click();
  await shot(page, '07-after-password-submit');
  await dumpHtml(page, '07-after-password-submit');

  // ─── Phase 5: dashboard ───
  // Best-effort match: standard wallet dashboard verbs.
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('receive') || t.includes('send') || t.includes('balance') || t.includes('account');
  }, undefined, { timeout: 30_000, polling: 250 });
  await shot(page, '08-dashboard');

  // eslint-disable-next-line no-console
  console.log(`[wizz:onboard] dashboard rendered — wallet committed.`);
});
