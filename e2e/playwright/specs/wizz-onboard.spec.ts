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
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 40_000));
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
  // Wizz's onboard is slow (multi-step + an address-derivation scan
  // on Step 3). The default 60s test timeout (playwright.config.ts)
  // is not enough to traverse every phase AND wait for the scan.
  test.setTimeout(180_000);

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
  // Unisat-style "Choose a wallet you want to restore from" with
  // Wizz Wallet at the top. The labels are non-interactive
  // <div class="relative"> children of a tappable row container —
  // the text node isn't the click target. Use force:true to let
  // the click bubble to whichever ancestor has the onClick handler.
  const sourceWizz = page.getByText('Wizz Wallet', { exact: true }).first();
  await expect(sourceWizz).toBeVisible({ timeout: 10_000 });
  await sourceWizz.click({ force: true });
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

  // ─── Phase 6: address-type screen (Step 3 — Wizz shows this
  //              after mnemonic; default selection is the wonky
  //              "Legacy & Taproot (P2TR)" m/44/0/0/0/0. Actively
  //              pick "Native Segwit (P2WPKH)" so the wallet ends
  //              up on the standard BIP-84 derivation that matches
  //              our test vectors.) ───
  await dumpHtml(page, '08a-address-type-screen');
  const nativeSegwitRow = page.getByText('Native Segwit (P2WPKH)', { exact: true }).first();
  if (await nativeSegwitRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await nativeSegwitRow.click({ force: true });
    await shot(page, '08b-native-segwit-picked');
  }

  // CI 26418861365 showed both 08c (post-click 1) and 08e (post-click 2)
  // still on the address-type screen with Native SegWit checked + an
  // active orange Continue button. The previous theory was a
  // two-click scan-then-advance dance; the actual evidence says the
  // click is landing on the wrong target. Likely cause: `force:true`
  // bypasses Playwright's actionability checks and dispatches at the
  // geometric centre, which on Wizz's Continue lands on a child span
  // or icon whose onClick handler is a no-op.
  //
  // Switch to `getByRole('button', { name: /^continue$/i }).last()`
  // (the row-action button is the LAST button in tab-order, after
  // "Back to Home" at the top), drop force:true, and scroll into
  // view before clicking. One click should be enough; the wallet
  // populates addresses synchronously after the mnemonic step.
  await page.waitForTimeout(500);
  const continueBtn = page.getByRole('button', { name: /^continue$/i }).last();
  await expect(continueBtn).toBeVisible({ timeout: 10_000 });
  await continueBtn.scrollIntoViewIfNeeded();
  await shot(page, '08c-before-continue-click');
  await continueBtn.click();
  await shot(page, '08d-after-continue-click');
  await page.waitForTimeout(2_000);
  await dumpHtml(page, '08e-after-continue-html');

  // ─── Phase 7: dashboard ───
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('receive') || t.includes('send') || t.includes('balance') || t.includes('account');
  }, undefined, { timeout: 60_000, polling: 500 });
  await shot(page, '09-dashboard');

  // eslint-disable-next-line no-console
  console.log(`[wizz:onboard] dashboard rendered — wallet committed.`);
});
