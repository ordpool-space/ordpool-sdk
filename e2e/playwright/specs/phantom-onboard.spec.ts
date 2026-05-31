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

test('restores a wallet from the BIP-39 test seed and lands on the dashboard', async () => {
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
  // Phantom's onClick handler ignores every Playwright API call up
  // through page.mouse.move+down+up (CI 26621231674..26650482318).
  // Drop to raw CDP Input.dispatchMouseEvent — one layer below
  // page.mouse — with explicit clickCount and buttons params.
  const cdp = await page.context().newCDPSession(page);
  const box = await importBtn.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
  await shot(page, '02-after-import-click');
  await dumpHtml(page, '02-after-import-click');

  // CI 26659564302 accessibility tree confirmed: post-CDP click the
  // page is at "Import a wallet" with buttons:
  //   - Connect Email Wallet
  //   - Import Recovery Phrase     ← what we want
  //   - Import Private Key
  //   - Connect Hardware Wallet
  // Use the same CDP click for this one.
  const recoveryBtn = page.getByRole('button', { name: /Import Recovery Phrase/i });
  await expect(recoveryBtn).toBeVisible({ timeout: 20_000 });
  const recoveryBox = await recoveryBtn.boundingBox();
  if (recoveryBox) {
    const x = recoveryBox.x + recoveryBox.width / 2;
    const y = recoveryBox.y + recoveryBox.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
  await shot(page, '03-recovery-phrase-picked');
  await dumpHtml(page, '03-recovery-phrase-picked');

  // Mnemonic entry — Phantom renders 12 textboxes with paragraph
  // labels 1, 2, 3, ... (accessibility tree from CI 26664331512).
  // Use any <input> rather than restricting by type attribute.
  const mnemonicInputs = page.locator('input, textarea');
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

  // Phantom's "Import Wallet" responds to regular Playwright clicks.
  const confirmAfterMnemonic = page.getByRole('button', { name: /^import wallet$/i });
  await expect(confirmAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await confirmAfterMnemonic.click();
  await shot(page, '05-after-mnemonic-submit');

  // CI 26693907192 revealed: Phantom shows a LOADING screen first
  // ("Import Accounts / Finding Accounts with Activity" + spinner)
  // then transitions to the result ("We found N accounts with
  // activity" + Continue button). My previous switch fired on
  // "Import Accounts" alone — that matched the loading state.
  // Switch only when "We found" appears (the result-state marker).
  const findResultPage = async () => {
    for (const p of context.pages()) {
      const text = await p.locator('body').innerText().catch(() => '');
      if (/We found .* accounts? with activity/i.test(text)) return p;
    }
    return null;
  };
  const deadline = Date.now() + 60_000;
  let newPage: Page | null = null;
  while (Date.now() < deadline) {
    newPage = await findResultPage();
    if (newPage) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (newPage) {
    page = newPage;
  }

  // Phantom "Import Accounts — We found N accounts with activity"
  // intermediate screen. Continue may be a styled div, not a <button>.
  // Match by exact text. Need CDP since the page may belong to a
  // freshly-opened tab; also recreate the CDP session for the new
  // page (the previous cdp was bound to the original mnemonic page).
  await shot(page, '05a-pre-continue-search');
  await dumpHtml(page, '05a-pre-continue-search');
  const importAccountsContinue = page.getByText('Continue', { exact: true }).first();
  if (await importAccountsContinue.isVisible({ timeout: 15_000 }).catch(() => false)) {
    const newCdp = await page.context().newCDPSession(page);
    const b = await importAccountsContinue.boundingBox();
    if (b) {
      const x = b.x + b.width / 2; const y = b.y + b.height / 2;
      await newCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await newCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await newCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    }
    await shot(page, '05b-after-import-accounts-continue');
    await dumpHtml(page, '05b-after-import-accounts-continue');
  }

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

  // Dashboard markers — never 'phantom' or 'account' (both
  // false-positive on Phantom's Import Accounts intermediate screen).
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance');
  }, undefined, { timeout: 60_000, polling: 500 });
  await shot(page, '08-dashboard');
  await dumpHtml(page, '08-dashboard');

  // eslint-disable-next-line no-console
  console.log('[phantom:onboard] dashboard rendered.');
});
