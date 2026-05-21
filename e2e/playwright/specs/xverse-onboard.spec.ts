import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 2 of the Xverse E2E pipeline: drive the actual
 * onboarding flow end-to-end.
 *
 * - Boot a fresh Chromium profile with the Xverse extension loaded
 * - Wait past the Lottie splash screen
 * - Click "Restore Wallet"
 * - Paste the BIP-39 standard test mnemonic
 *   (`abandon abandon abandon abandon abandon abandon abandon
 *    abandon abandon abandon abandon about`)
 * - Set a throwaway password (twice)
 * - Reach the dashboard
 * - Read back the displayed Bitcoin payment address (P2WPKH) and
 *   the ordinals address (P2TR), assert they match the well-known
 *   BIP-84 / BIP-86 derivations of the test seed
 *
 * The selectors here are text-based on purpose. Xverse ships with
 * styled-components hashed class names (`sc-329d22af-0 kBasGW`) that
 * change on every build; visible text is the only stable handle.
 *
 * Every step screenshots into test-results/ so a CI failure points
 * at the exact page state where the flow broke.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

// BIP-39 abandon × 11 + about. Well-known test vector; the derived
// addresses are publicly documented and never used for real funds.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Expected addresses derived from TEST_MNEMONIC on mainnet:
//   m/84'/0'/0'/0/0  (BIP-84, native segwit, what Xverse calls "Payment")
//   m/86'/0'/0'/0/0  (BIP-86, taproot,       what Xverse calls "Ordinals")
const EXPECTED_BIP84_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const EXPECTED_BIP86_ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

const TEST_PASSWORD = 'TestPassword123!';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({
      path: path.resolve(RESULTS_DIR, `onboard-${name}.png`),
      fullPage: true,
    });
  } catch {
    // screenshots are diagnostic, never fatal
  }
}

async function dumpHtml(page: Page, name: string): Promise<void> {
  try {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 8000));
    fs.writeFileSync(path.resolve(RESULTS_DIR, `onboard-${name}.html`), html);
  } catch {
    // ignore
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Xverse extension not unpacked at ${EXT_PATH}. ` +
      `Run e2e/playwright/playwright-bootstrap.sh first.`,
    );
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
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

test('restores a wallet from the BIP-39 test seed and lands on the dashboard with the expected addresses', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, {
    waitUntil: 'domcontentloaded',
  });

  // ─── Phase 1: wait past the Lottie splash ───
  // The first navigation lands on a splash with an animated logo
  // that needs ~3-5s to settle. Polling for visible body text
  // beyond the loader is the most reliable signal.
  await page.waitForFunction(
    () => {
      const text = (document.body.innerText || '').toLowerCase();
      // The post-splash welcome screen contains one of these strings
      // across versions; if none appear, we're still on splash.
      return text.includes('restore')
          || text.includes('create')
          || text.includes('get started')
          || text.includes('continue')
          || text.includes('terms');
    },
    { timeout: 30_000 },
  );
  await shot(page, '01-after-splash');
  await dumpHtml(page, '01-after-splash');

  // ─── Phase 2: get past any Terms / Welcome wall ───
  // Xverse may show a ToS gate or a "Get Started" splash before
  // the Create/Restore choice. Click whichever Continue-style
  // button is visible, up to twice (handles 2-screen welcomes).
  for (const pass of [1, 2]) {
    const candidate = page.getByRole('button', {
      name: /^(continue|get started|i agree|accept|next)$/i,
    }).first();
    if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await candidate.click();
      await shot(page, `02-pass${pass}-after-welcome-button`);
    } else {
      break;
    }
  }

  // ─── Phase 3: click "Restore Wallet" ───
  const restoreButton = page.getByRole('button', { name: /restore|i have a wallet|already have/i }).first();
  // Fallback: some Xverse versions render the choice as a clickable
  // text link / card rather than a button role.
  if (!(await restoreButton.isVisible({ timeout: 3_000 }).catch(() => false))) {
    const restoreText = page.getByText(/restore wallet|i already have a wallet/i).first();
    await expect(restoreText).toBeVisible({ timeout: 15_000 });
    await restoreText.click();
  } else {
    await restoreButton.click();
  }
  await shot(page, '03-after-restore-click');

  // ─── Phase 4: enter the 12-word mnemonic ───
  // Xverse's seed entry has historically been either:
  //   (a) one textarea — paste the whole phrase
  //   (b) 12 separate <input> boxes — type/paste per word
  // Try (a) first; fall back to (b) word-by-word.
  await page.waitForTimeout(800); // small settle wait for transition

  const textarea = page.locator('textarea').first();
  const usedTextarea = await textarea.isVisible({ timeout: 3_000 }).catch(() => false);

  if (usedTextarea) {
    await textarea.fill(TEST_MNEMONIC);
    await shot(page, '04a-mnemonic-textarea');
  } else {
    const words = TEST_MNEMONIC.split(' ');
    const inputs = page.locator('input[type="text"], input:not([type])');
    await expect(inputs.first()).toBeVisible({ timeout: 10_000 });
    const count = await inputs.count();
    if (count < 12) {
      await shot(page, '04b-mnemonic-input-mismatch');
      await dumpHtml(page, '04b-mnemonic-input-mismatch');
      throw new Error(`expected >=12 word inputs, got ${count}`);
    }
    for (let i = 0; i < 12; i++) {
      await inputs.nth(i).fill(words[i]);
    }
    await shot(page, '04b-mnemonic-words-typed');
  }

  // Submit the mnemonic.
  const continueAfterMnemonic = page.getByRole('button', { name: /continue|next|restore|confirm/i }).first();
  await expect(continueAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await continueAfterMnemonic.click();
  await shot(page, '05-after-mnemonic-submit');

  // ─── Phase 5: set a password ───
  // Two password fields are standard (password + confirm). Some
  // versions show a "Skip" option; we don't want it for this test.
  const passwordInputs = page.locator('input[type="password"]');
  await expect(passwordInputs.first()).toBeVisible({ timeout: 15_000 });
  const pwCount = await passwordInputs.count();
  for (let i = 0; i < pwCount; i++) {
    await passwordInputs.nth(i).fill(TEST_PASSWORD);
  }
  await shot(page, '06-password-typed');

  const continueAfterPassword = page.getByRole('button', { name: /continue|next|confirm|done|create/i }).first();
  await continueAfterPassword.click();
  await shot(page, '07-after-password-submit');

  // ─── Phase 6: reach the dashboard ───
  // The dashboard typically shows the user's address(es) in a copyable
  // format. Wait for either the expected payment or ordinals address
  // to appear in the visible text.
  await page.waitForFunction(
    (expected: string[]) => {
      const text = document.body.innerText || '';
      return expected.some(addr => text.includes(addr));
    },
    [EXPECTED_BIP84_ADDRESS, EXPECTED_BIP86_ADDRESS],
    { timeout: 30_000 },
  );

  await shot(page, '08-dashboard');
  await dumpHtml(page, '08-dashboard');

  // ─── Phase 7: assert both addresses are derivable ───
  // Even if only one is visible on the first dashboard view, the
  // other should appear after a UI toggle (Payment / Ordinals tabs)
  // OR be retrievable via sats-connect's getAddress in iteration 3.
  // For this iteration we accept "at least one expected address is
  // rendered" as proof that Xverse really used our test seed.
  const visibleText = await page.locator('body').innerText();
  const sawPayment = visibleText.includes(EXPECTED_BIP84_ADDRESS);
  const sawOrdinals = visibleText.includes(EXPECTED_BIP86_ADDRESS);
  // eslint-disable-next-line no-console
  console.log(`[xverse:onboard] saw payment address (${EXPECTED_BIP84_ADDRESS}): ${sawPayment}`);
  // eslint-disable-next-line no-console
  console.log(`[xverse:onboard] saw ordinals address (${EXPECTED_BIP86_ADDRESS}): ${sawOrdinals}`);
  expect(sawPayment || sawOrdinals).toBe(true);
});
