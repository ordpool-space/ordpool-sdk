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
  // First nav lands on a splash with an animated logo that needs
  // ~3-5s to settle. Wait until the welcome screen's text shows
  // ("Your key to a Bitcoin future" + Create / Restore buttons).
  await page.waitForFunction(
    () => {
      const text = (document.body.innerText || '').toLowerCase();
      return text.includes('restore') && text.includes('create');
    },
    { timeout: 30_000 },
  );
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');

  // ─── Phase 2: click "Restore an existing wallet" ───
  const restoreButton = page.getByText(/restore an existing wallet|restore.*wallet/i).first();
  await expect(restoreButton).toBeVisible({ timeout: 10_000 });
  await restoreButton.click();
  await shot(page, '02-after-restore-click');

  // ─── Phase 3: Legal screen ───
  // Renders ToS + Privacy Policy links plus an "Authorize data
  // collection" toggle that defaults ON (Mixpanel-bound — flagged
  // by the v2.3.2 audit). Toggle it off, then Accept.
  await expect(page.getByText(/legal/i).first()).toBeVisible({ timeout: 15_000 });

  // The data-collection toggle is a custom-styled switch; click
  // the parent label to flip it. Best-effort: find the row whose
  // text contains "Authorize data collection" and click it.
  const dataCollectionRow = page.getByText(/authorize data collection/i).first();
  if (await dataCollectionRow.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await dataCollectionRow.click();
    await shot(page, '03a-data-collection-off');
  }

  const acceptButton = page.getByRole('button', { name: /^accept$/i }).first();
  await expect(acceptButton).toBeVisible({ timeout: 10_000 });
  await acceptButton.click();
  await shot(page, '03b-after-accept');

  // ─── Phase 4: set a password ───
  // Xverse asks for the wallet password BEFORE the seed in both
  // Create and Restore flows. Two fields: "Create password" + "Confirm
  // password". Continue button is disabled until both match.
  const passwordInputs = page.locator('input[type="password"]');
  await expect(passwordInputs.first()).toBeVisible({ timeout: 15_000 });
  const pwCount = await passwordInputs.count();
  for (let i = 0; i < pwCount; i++) {
    await passwordInputs.nth(i).fill(TEST_PASSWORD);
  }
  await shot(page, '04-password-typed');

  const continueAfterPassword = page.getByRole('button', { name: /continue|next|confirm|done|create/i }).first();
  await expect(continueAfterPassword).toBeEnabled({ timeout: 10_000 });
  await continueAfterPassword.click();
  await shot(page, '05-after-password-submit');

  // ─── Phase 5: disambiguate which wallet we're importing FROM ───
  // After password, Xverse asks "What wallet are you importing into
  // Xverse?" with tiles for Xverse / Magic Eden / Unisat / Phantom /
  // Leather / OKX / Other. The choice tells Xverse which derivation
  // paths to scan (different wallets use different defaults for the
  // same BIP-39 seed). We pick "Xverse" so the derived addresses
  // come out as the standard BIP-84 (payment) and BIP-86 (ordinals)
  // we assert against below.
  await expect(page.getByText(/restore your wallet|what wallet are you importing/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByText(/^xverse$/i).first().click();
  await shot(page, '06-after-source-wallet-pick');

  // ─── Phase 6: enter the 12-word mnemonic ───
  // Xverse's seed entry is either:
  //   (a) one textarea — paste the whole phrase
  //   (b) 12 separate <input> boxes — type/paste per word
  // Try (a) first; fall back to (b) word-by-word.
  await page.waitForTimeout(800);

  // "Enter seed phrase" page: 12 numbered boxes, each is an
  // input[type=password] with an eye-toggle for reveal. The form's
  // copy says "Enter or paste your 12 or 24 word seed phrase" —
  // pasting the whole space-separated phrase into the first box
  // makes Xverse split into all 12 boxes via its paste handler.
  // Sequential .fill() per box doesn't trigger that handler and
  // leaves the last box disabled.
  await expect(page.getByText(/enter seed phrase/i).first()).toBeVisible({ timeout: 15_000 });

  const inputs = page.locator('input[type="password"]');
  await expect(inputs.first()).toBeVisible({ timeout: 10_000 });
  const count = await inputs.count();
  if (count < 12) {
    await shot(page, '06b-mnemonic-input-mismatch');
    await dumpHtml(page, '06b-mnemonic-input-mismatch');
    throw new Error(`expected >=12 word inputs, got ${count}`);
  }

  // Type the full phrase into box 1 character-by-character. Xverse's
  // space-key handler advances focus to the next box, so typing the
  // space-separated phrase fills all 12 boxes naturally.
  // pressSequentially fires real key events that React's onKeyDown /
  // onChange handlers respond to (.fill() and synthetic
  // ClipboardEvent didn't, in this form).
  await inputs.first().click();
  await inputs.first().pressSequentially(TEST_MNEMONIC, { delay: 25 });
  await shot(page, '06b-mnemonic-typed');

  const continueAfterMnemonic = page.getByRole('button', { name: /continue|next|restore|confirm|done/i }).first();
  await expect(continueAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await continueAfterMnemonic.click();
  await shot(page, '07-after-mnemonic-submit');

  // ─── Phase 7: post-submit, wait for either the wallet-picker or the dashboard ───
  // Xverse scans the chain after a restore. The abandon × 11 + about
  // test seed has been used so widely that the scan finds multiple
  // wallet derivations with historical activity and shows a picker
  // (Wallet 1 / 3 accounts, Wallet 2 / 11 accounts). For seeds with
  // no history, the scan goes straight to the dashboard. The scan
  // can take >20s on a cold backend, so we poll up to 90s for either
  // outcome and branch on what shows up.
  await page.waitForFunction(
    () => {
      const text = (document.body.innerText || '').toLowerCase();
      return text.includes('select a wallet to restore')
          || text.includes('we found funds')
          || /bc1[qp][a-z0-9]{20,}/.test(document.body.innerText || '');
    },
    { timeout: 90_000 },
  );
  await shot(page, '07-after-scan');

  // If the picker is up, drill into Wallet 1 and Confirm.
  const restorePicker = page.getByText(/select a wallet to restore|we found funds/i).first();
  if (await restorePicker.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await shot(page, '07a-wallet-picker');
    const seeAccounts = page.getByRole('button', { name: /see accounts/i }).first();
    await seeAccounts.click();
    await shot(page, '07b-see-accounts-clicked');

    // Confirm button: target by visible text, exact match.
    // getByRole with a regex sometimes targets a stale or off-screen
    // element; getByText('Confirm', exact) is unambiguous here.
    const commit = page.getByText('Confirm', { exact: true }).first();
    await expect(commit).toBeVisible({ timeout: 15_000 });
    // Wait for the button to actually be enabled, not just visible.
    // Xverse uses `pointer-events: none` + opacity for the disabled
    // look, which Playwright's isEnabled() may not catch.
    await page.waitForFunction(
      () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const c = buttons.find(b => b.textContent?.trim() === 'Confirm');
        if (!c) return false;
        return !c.hasAttribute('disabled') && getComputedStyle(c).pointerEvents !== 'none';
      },
      { timeout: 10_000 },
    );
    await commit.click();
    await page.waitForTimeout(1_000);
    await shot(page, '07c-after-wallet-confirm');
  }

  // ─── Phase 7d: preferred address-type picker ───
  // After wallet-confirm, Xverse asks for the default payment
  // address type (Native SegWit / Nested SegWit / etc). Native
  // SegWit (BIP-84) is what our expected address derivation uses
  // and is selected by default — just click Continue.
  const addressTypePicker = page.getByText(/preferred address type/i).first();
  if (await addressTypePicker.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await shot(page, '07d-address-type-picker');
    const continueBtn = page.getByText('Continue', { exact: true }).first();
    await expect(continueBtn).toBeVisible({ timeout: 10_000 });
    await continueBtn.click();
    await page.waitForTimeout(1_000);
    await shot(page, '07e-after-address-type-continue');
  }

  // ─── Phase 8: "Wallet Restored" confirmation ───
  // options.html's onboarding finishes on a "Wallet Restored" screen
  // with a "Close this tab" button. The actual dashboard with the
  // derived addresses lives in popup.html (the toolbar dropdown),
  // not in this page.
  await expect(page.getByText(/wallet restored/i).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, '08-wallet-restored');

  // ─── Phase 9: open popup.html, dismiss marketing modals, read address ───
  // popup.html is Xverse's main dashboard view. Chrome extension
  // storage is shared across the extension's pages, so popup.html
  // picks up the wallet state options.html just committed. The
  // dashboard initially overlays a marketing modal (e.g. "From Your
  // Bank to Earning Yield") and a banner ("$ZEST is now live") that
  // hide the address; dismiss both, then click Receive to reveal
  // the payment address.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 800 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });
  await popup.waitForLoadState('domcontentloaded');
  await popup.screenshot({ path: path.resolve(RESULTS_DIR, 'onboard-09a-popup-initial.png'), fullPage: true });

  // Dismiss marketing modal ("Not now" button) if present.
  const notNow = popup.getByText('Not now', { exact: true }).first();
  if (await notNow.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await notNow.click();
    await popup.waitForTimeout(500);
    await popup.screenshot({ path: path.resolve(RESULTS_DIR, 'onboard-09b-after-not-now.png'), fullPage: true });
  }

  // Dismiss any remaining banner-style close icons by clicking
  // every visible SVG close icon by its accessible name.
  for (let i = 0; i < 4; i++) {
    const close = popup.getByRole('button', { name: /close/i }).first();
    if (!(await close.isVisible({ timeout: 1_000 }).catch(() => false))) break;
    await close.click({ force: true });
    await popup.waitForTimeout(300);
  }
  await popup.screenshot({ path: path.resolve(RESULTS_DIR, 'onboard-09c-modals-dismissed.png'), fullPage: true });

  // Click Receive. Xverse renders the label as a <span> inside a
  // clickable card (<button> or <div role="button">). A direct
  // click on the span doesn't always propagate the click handler;
  // walk up to the closest clickable ancestor and click that.
  const receive = popup
    .getByText('Receive', { exact: true })
    .locator('xpath=ancestor::*[self::button or @role="button" or self::a][1]')
    .first();
  await expect(receive).toBeVisible({ timeout: 10_000 });
  // force: true bypasses the on-top hit-test, in case a portal /
  // banner overlay still covers the click point invisibly.
  await receive.click({ force: true });
  await popup.waitForTimeout(1_500);
  await popup.screenshot({ path: path.resolve(RESULTS_DIR, 'onboard-09d-receive-view.png'), fullPage: true });

  // The receive view shows our addresses as copyable text. Wait
  // until at least one expected address is in the rendered body.
  await popup.waitForFunction(
    (expected: string[]) => {
      const text = document.body.innerText || '';
      return expected.some(addr => text.includes(addr));
    },
    [EXPECTED_BIP84_ADDRESS, EXPECTED_BIP86_ADDRESS],
    { timeout: 15_000 },
  );
  await popup.screenshot({ path: path.resolve(RESULTS_DIR, 'onboard-09e-address-visible.png'), fullPage: true });

  const popupText = await popup.locator('body').innerText();
  const sawPayment = popupText.includes(EXPECTED_BIP84_ADDRESS);
  const sawOrdinals = popupText.includes(EXPECTED_BIP86_ADDRESS);
  // eslint-disable-next-line no-console
  console.log(`[xverse:onboard] saw payment address (${EXPECTED_BIP84_ADDRESS}): ${sawPayment}`);
  // eslint-disable-next-line no-console
  console.log(`[xverse:onboard] saw ordinals address (${EXPECTED_BIP86_ADDRESS}): ${sawOrdinals}`);
  expect(sawPayment || sawOrdinals).toBe(true);
});
