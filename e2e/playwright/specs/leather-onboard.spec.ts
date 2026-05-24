import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 2 of the Leather E2E pipeline: drive the onboarding
 * flow from the BIP-39 test seed.
 *
 * The welcome page (`index.html#/get-started`) exposes two
 * testids: `sign-up-btn` (Create new wallet) and `sign-in-link`
 * (Use existing key). The downstream restore screens don't ship
 * testids in the bundle's static strings — selectors discovered
 * empirically via screenshots, this spec lands the first
 * approximation and the next iteration tightens it.
 *
 * Flow we're trying:
 *  1. click `sign-in-link`
 *  2. enter the 12 mnemonic words (textarea or per-word boxes)
 *  3. click Continue
 *  4. set password (twice)
 *  5. land on dashboard
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/leather');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Leather's password-strength meter (likely zxcvbn) rates the
// shared `TestPassword123!` as "Poor" and refuses to enable
// Continue. CI 26375584175 / 05-password-typed.png shows the rule
// at work. Use a longer high-entropy passphrase for Leather only;
// Xverse and Unisat keep `TestPassword123!`.
const TEST_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `leather-onboard-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function dumpHtml(page: Page, name: string): Promise<void> {
  try {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 8000));
    fs.writeFileSync(path.resolve(RESULTS_DIR, `leather-onboard-${name}.html`), html);
  } catch {
    // ignore
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Leather extension not unpacked at ${EXT_PATH}.`);
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
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  // ─── Phase 1: welcome screen → "Use existing key" ───
  await expect(page.getByTestId('sign-in-link')).toBeVisible({ timeout: 15_000 });
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');
  await page.getByTestId('sign-in-link').click();
  await shot(page, '02-after-sign-in-click');
  await dumpHtml(page, '02-after-sign-in-click');

  // ─── Phase 2: mnemonic entry ───
  // The restore screen renders either (a) a single textarea or
  // (b) 12 per-word inputs. Try the textarea first; fall back to
  // per-word fill.
  let mnemonicEntered = false;
  const textarea = page.locator('textarea').first();
  if (await textarea.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await textarea.fill(TEST_MNEMONIC);
    mnemonicEntered = true;
    await shot(page, '03-mnemonic-textarea-filled');
  } else {
    // Per-word fallback: find 12 text inputs in order.
    const inputs = page.locator('input[type="text"], input[type="password"]');
    const count = await inputs.count();
    if (count >= 12) {
      const words = TEST_MNEMONIC.split(' ');
      for (let i = 0; i < 12; i++) {
        await inputs.nth(i).fill(words[i]);
      }
      mnemonicEntered = true;
      await shot(page, '03-mnemonic-per-word-filled');
    }
  }

  if (!mnemonicEntered) {
    await dumpHtml(page, '03-mnemonic-input-not-found');
    throw new Error('Could not find mnemonic input (no textarea, fewer than 12 text inputs)');
  }

  // Continue button — Leather typically labels it "Continue" or "Sign in".
  const continueBtn = page.getByRole('button', { name: /continue|sign in|restore|confirm/i }).first();
  await expect(continueBtn).toBeVisible({ timeout: 10_000 });
  await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
  await continueBtn.click();
  await shot(page, '04-after-mnemonic-submit');
  await dumpHtml(page, '04-after-mnemonic-submit');

  // ─── Phase 3: "Set a Password" screen — single input + Continue ───
  // Use the bundle's known testids (`password-input`, `set-password-btn`)
  // rather than `input[type="password"]`. The latter also matches
  // the mnemonic-input-N boxes from the previous screen that linger
  // in the DOM during React's route transition, and pressSequentially
  // ends up typing into a hidden/detached one (CI run 26374826897:
  // screenshot 05-password-typed.png showed the visible field still
  // empty after our typing call).
  // The actual testid is `set-or-enter-password-input` per the
  // OnboardingSelectors enum in the bundle (used by both the
  // create-new-wallet and use-existing-key flows).
  const pwInput = page.getByTestId('set-or-enter-password-input');
  await expect(pwInput).toBeVisible({ timeout: 15_000 });
  await pwInput.click();
  await pwInput.pressSequentially(TEST_PASSWORD, { delay: 15 });
  await shot(page, '05-password-typed');

  const confirmBtn = page.getByTestId('set-password-btn');
  await expect(confirmBtn).toBeEnabled({ timeout: 10_000 });
  await confirmBtn.click();
  await shot(page, '06-after-password-submit');
  await dumpHtml(page, '06-after-password-submit');

  // ─── Phase 4: dashboard rendered ───
  // The dashboard's primary indicator: a balance display or the
  // wallet name. Best-effort match for now; will tighten once
  // we've seen the actual rendered state in CI.
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('bitcoin');
  }, undefined, { timeout: 30_000, polling: 250 });
  await shot(page, '07-dashboard');

  // eslint-disable-next-line no-console
  console.log(`[leather:onboard] dashboard rendered — wallet committed.`);
});
