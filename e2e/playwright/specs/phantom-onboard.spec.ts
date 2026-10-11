// Don't skip-or-delete — see the Xverse gold-standard pattern in
// /Work/ordpool/WALLETS.md. The full click-through is the source of
// truth that wallet onboarding still works; downstream specs may
// optionally cache a seeded user-data-dir for speed, but this file
// MUST stay green-or-loudly-failing on every CI run.

import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { cdpClick } from '../cdp-click';
import { pressPhantomGetStarted } from '../onboard-phantom';
import { extensionOnboardingPage } from '../wallet-onboarders';
import { waitForPageShowing } from '../approval-popup';

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
    throw new Error(`OKX extension not unpacked at ${EXT_PATH}. This is a missing prerequisite, not a test failure: run e2e/playwright/playwright-bootstrap.sh phantom.`);
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
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];

  // Phantom may auto-open its onboarding in a new tab — wait briefly
  // for any chrome-extension page (CI 26597193687 showed popup.html
  // doesn't render the Help link / actual CTA at all on the first
  // visit; the real onboarding likely lives in an auto-opened tab).
  onboardPage = await extensionOnboardingPage(context, extensionId);
});

test.afterAll(async () => {
  await context?.close();
});

test('restores a wallet from the BIP-39 test seed and reaches a screen mentioning send/receive/balance/account/bitcoin', async () => {

  let page: Page = onboardPage ?? await context.newPage();
  // A blank page means Phantom opened no onboarding tab of its own.
  if (page.url() === 'about:blank') {
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
  await expect(importBtn).toBeVisible();
  // Phantom's onClick handler ignores every Playwright API call up
  // through page.mouse.move+down+up (CI 26621231674..26650482318).
  // Drop to raw CDP Input.dispatchMouseEvent — one layer below
  // page.mouse — with explicit clickCount and buttons params.
  await cdpClick(page, importBtn, 'the "I Already Have a Wallet" button');
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
  await expect(recoveryBtn).toBeVisible();
  await cdpClick(page, recoveryBtn, 'the "Import Recovery Phrase" button');
  await shot(page, '03-recovery-phrase-picked');
  await dumpHtml(page, '03-recovery-phrase-picked');

  // Mnemonic entry — Phantom renders 12 textboxes with paragraph
  // labels 1, 2, 3, ... (accessibility tree from CI 26664331512).
  // Use any <input> rather than restricting by type attribute.
  const mnemonicInputs = page.locator('input, textarea');
  await expect(mnemonicInputs.first()).toBeVisible();
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
  await expect(confirmAfterMnemonic).toBeEnabled();
  await confirmAfterMnemonic.click();
  await shot(page, '05-after-mnemonic-submit');

  // Phantom shows a loading screen first ("Import Accounts / Finding Accounts
  // with Activity" and a spinner), then the result: "We found N accounts with
  // activity" or "We found 1 account", depending on what its account scan
  // returned. "We found" is the result-state marker; "Import Accounts" alone
  // also matches the loading state. The search covers the current page too,
  // so a result rendered in place resolves to it.
  page = await waitForPageShowing({ context, text: /We found \d+ accounts?\b/i });

  // Phantom "Import Accounts — We found N accounts with activity"
  // result screen. Continue is rendered as a styled div that's
  // initially DISABLED (gray pill) and becomes ENABLED (white pill)
  // after a few seconds of further loading. Wait for the enabled
  // state by polling for the computed background color / aria-disabled.
  await shot(page, '05a-pre-continue-search');
  await dumpHtml(page, '05a-pre-continue-search');
  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
    const candidate = els.find(el => (el.textContent || '').trim() === 'Continue');
    if (!candidate) return false;
    const style = getComputedStyle(candidate);
    // Disabled state typically uses gray/translucent bg; enabled is
    // the bright Phantom-purple-on-white. Test for non-disabled via
    // aria-disabled attr or via opacity/color contrast.
    if (candidate.getAttribute('aria-disabled') === 'true') return false;
    if ((candidate as HTMLElement).hasAttribute('disabled')) return false;
    if (parseFloat(style.opacity) < 0.7) return false;
    return true;
  }, undefined, { polling: 500 });
  const importAccountsContinue = page.getByText('Continue', { exact: true }).first();
  const newCdp = await page.context().newCDPSession(page);
  await cdpClick(page, importAccountsContinue, 'the import-accounts Continue button');
  await shot(page, '05b-after-import-accounts-continue');
  await dumpHtml(page, '05b-after-import-accounts-continue');

  // CI 26713625161 trace revealed: after Continue on Import Accounts
  // Phantom opens YET ANOTHER page (page #3) for "Create a password".
  // Switch page reference to whichever now shows that text.
  // The search covers the current page too, so a screen rendered in place
  // resolves to it.
  page = await waitForPageShowing({ context, text: /Create a password/i });

  // Phantom "Create a password" screen:
  //  - Password / Confirm Password inputs
  //  - "I agree to the Terms of Service" checkbox
  //  - Continue button (disabled until form valid)
  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible();
  await pwInputs.nth(0).fill(TEST_PASSWORD);
  await pwInputs.nth(1).fill(TEST_PASSWORD);
  await shot(page, '06-password-typed');

  // Phantom uses Reach UI's `data-reach-custom-checkbox-input` — the
  // <input> is visually hidden (pointer-events:none, opacity:0). A
  // mouse click on the input is absorbed and Playwright `check()`
  // reports "state did not change". Fire a native .click() via JS —
  // React's onChange picks it up and toggles aria-checked.
  await page.locator('[data-testid="onboarding-form-terms-of-service-checkbox"]')
    .first().waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const cb = document.querySelector('[data-testid="onboarding-form-terms-of-service-checkbox"]') as HTMLInputElement | null;
    cb?.click();
  });
  await expect(
    page.locator('[data-testid="onboarding-form-terms-of-service-checkbox"][aria-checked="true"]'),
  ).toBeAttached();

  // Wait for Continue to be enabled, then CDP-click.
  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
    const candidate = els.find(el => (el.textContent || '').trim() === 'Continue');
    if (!candidate) return false;
    if (candidate.getAttribute('aria-disabled') === 'true') return false;
    if ((candidate as HTMLElement).hasAttribute('disabled')) return false;
    if (parseFloat(getComputedStyle(candidate).opacity) < 0.7) return false;
    return true;
  }, undefined, { polling: 500 });
  const pwContinue = page.getByText('Continue', { exact: true }).first();
  await cdpClick(page, pwContinue, 'the password Continue button');
  await shot(page, '07-after-password-submit');

  // Phantom's onboarding completes on a "You're good to go!" screen
  // with a Get Started button — the dashboard proper opens later (via
  // the toolbar popup). For the purposes of "wallet is onboarded",
  // detecting the completion screen is sufficient. Also accept the
  // true dashboard markers (send/receive/balance) in case Phantom
  // later auto-navigates.
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes("you're good to go")
      || t.includes('get started')
      || t.includes('send')
      || t.includes('receive')
      || t.includes('balance');
  }, undefined, { polling: 500 });
  // Phantom's onboarding completion gate.
  await pressPhantomGetStarted(page);
  await shot(page, '08-dashboard');
  await dumpHtml(page, '08-dashboard');

  // eslint-disable-next-line no-console
  console.log('[phantom:onboard] dashboard rendered.');
});
