import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 2 of the Wizz E2E pipeline: drive the onboarding flow
 * from the BIP-39 test seed.
 *
 * Wizz is a fork of Unisat (formerly Atom Wallet); the UI is
 * derived from the same React codebase. First attempt uses Unisat's
 * testid set as-is — if Wizz renamed any, the failing assertion
 * artifacts will show what to adjust.
 *
 * Manifest's `default_popup` is `temp.html` (init splash); the
 * actual onboarding lives at `index.html` — we navigate there
 * directly.
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
  // Wizz is a Unisat fork; reuse Unisat's testid set.
  await expect(page.getByTestId('welcome-title')).toBeVisible({ timeout: 15_000 });
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');

  // ─── Phase 2: "I already have a wallet" ───
  await page.getByTestId('import-wallet-button').click();
  await shot(page, '02-after-import-click');

  // ─── Phase 3: create password ───
  await expect(page.getByTestId('create-password-input')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-confirm-input').fill(TEST_PASSWORD);
  await shot(page, '03-password-typed');

  await page.getByTestId('create-password-continue-button').click();
  await shot(page, '04-after-password-submit');

  // ─── Phase 4: source-wallet picker (Wizz/Atom Wallet at index 0) ───
  await expect(page.getByTestId('restore-wallet-type-option-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('restore-wallet-type-option-0').click();
  await shot(page, '05-source-wallet-picked');

  // ─── Phase 5: mnemonic word inputs ───
  await expect(page.getByTestId('mnemonic-import-word-0')).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await page.getByTestId(`mnemonic-import-word-${i}`).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await shot(page, '06-mnemonic-filled');
  await page.getByTestId('mnemonic-import-continue-button').click();
  await shot(page, '07-after-mnemonic-continue');

  // ─── Phase 6: address-type screen (optional / version-dependent) ───
  const addressTypeContinue = page.getByTestId('address-type-continue-button');
  if (await addressTypeContinue.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await shot(page, '08-address-type-picker');
    await addressTypeContinue.click();
    await shot(page, '09-after-address-type-continue');
  }

  // ─── Phase 7: post-restore notice (optional) ───
  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (await noticeCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await noticeCheckbox.click();
    const noticeOk = page.getByTestId('notice-ok-button');
    if (await noticeOk.isEnabled({ timeout: 3_000 }).catch(() => false)) {
      await noticeOk.click();
    }
    await shot(page, '10-notice-dismissed');
  }

  // ─── Phase 8: dashboard ───
  await expect(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
  await shot(page, '11-dashboard');

  // eslint-disable-next-line no-console
  console.log(`[wizz:onboard] dashboard renders (tab-home visible) — wallet committed.`);
});
