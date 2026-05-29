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

const EXT_PATH = path.resolve(__dirname, '../../extensions/phantom');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

let context: BrowserContext;
let extensionId: string;
let onboardPage: Page | null = null;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `phantom-onboard-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function dumpHtml(page: Page, name: string): Promise<void> {
  try {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 40_000));
    fs.writeFileSync(path.resolve(RESULTS_DIR, `phantom-onboard-${name}.html`), html);
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

  // Phantom may auto-open its onboarding in a new tab — wait briefly
  // for any chrome-extension page (CI 26597193687 showed popup.html
  // doesn't render the Help link / actual CTA at all on the first
  // visit; the real onboarding likely lives in an auto-opened tab).
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

// Skipped — Phantom's welcome screen does not advance under
// Playwright automation. Across 4 CI iterations (26621231674,
// 26631233318, 26645369070, 26650482318) the same welcome screen
// ("Create a New Wallet" / "I Already Have a Wallet") was captured
// POST-click for every tried activation strategy:
//
//   - getByRole('button').click()                        → no nav
//   - .click({ force: true })                            → no nav
//   - keyboard.press('Enter') after .focus()             → no nav
//   - DOM-level HTMLElement.click() via page.evaluate    → no nav
//   - page.mouse.move + mouse.down + mouse.up at coords  → no nav
//
// HTML dumps after each click consistently show the unchanged
// welcome markup. Phantom's React component appears to filter
// `isTrusted: false` events — the standard wallet anti-automation
// pattern. End-to-end automation would require either CDP-level
// event forging (not portable) or external state injection via
// chrome.storage.local (Xverse-style — possible follow-up).
test.skip('restores a wallet from the BIP-39 test seed and lands on the dashboard', async () => {
  test.setTimeout(180_000);

  let page: Page;
  if (onboardPage) {
    page = onboardPage;
  } else {
    page = await context.newPage();
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'networkidle' });
  }
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');

  // Phantom welcome (CI 26602529964 dump confirmed): "Create a New
  // Wallet" + "I Already Have a Wallet" buttons. Match by button role
  // so we don't hit the help-text paragraph that also contains
  // "import" / "wallet".
  const importBtn = page.getByRole('button', { name: 'I Already Have a Wallet' });
  await expect(importBtn).toBeVisible({ timeout: 30_000 });
  // Phantom's React component ignores synthetic .click(),
  // keyboard.press('Enter'), AND DOM-level element.click() (CI
  // 26621231674, 26631233318, 26645369070 — same welcome state
  // every time). Use page.mouse.click at the button's coordinates;
  // that simulates real OS-level mouse events through Chromium's
  // input pipeline, which React's CSP-isolated onClick handlers do
  // observe.
  const box = await importBtn.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
  }
  await shot(page, '02-after-import-click');
  await dumpHtml(page, '02-after-import-click');

  // Import-source picker — likely options like "Seed phrase" /
  // "Mnemonic" / "Recovery phrase". Pick the seed-phrase option.
  const seedOption = page.getByText(/seed phrase|mnemonic|recovery phrase/i).first();
  if (await seedOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await seedOption.click();
    await shot(page, '03-seed-option-picked');
  }

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
  console.log('[phantom:onboard] dashboard rendered.');
});
