// Don't skip-or-delete — see the Xverse gold-standard pattern in
// /Work/ordpool/WALLETS.md. The full click-through is the source of
// truth that wallet onboarding still works; downstream specs may
// optionally cache a seeded user-data-dir for speed, but this file
// MUST stay green-or-loudly-failing on every CI run.

import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 2 of the Unisat E2E pipeline: drive the actual
 * onboarding flow end-to-end.
 *
 * - Boot a fresh Chromium profile with the Unisat extension loaded
 * - Click "I already have a wallet" (data-testid="import-wallet-button")
 * - Pick "Restore from mnemonic"
 * - Fill the 12 mnemonic word inputs from the BIP-39 standard test
 *   seed (`abandon × 11 + about`)
 * - Continue past the optional address-type picker
 * - Set a throwaway password (twice)
 * - Reach the dashboard, prove the home tab rendered
 *
 * Unisat is MIT-licensed (github.com/unisat-wallet/extension) and
 * every onboarding control has a stable data-testid, so we use
 * those exclusively — no fragile text matching. Selector list
 * grepped from the bundled ui.js v1.7.15.
 *
 * Address-correctness verification lives in iteration 3 (the
 * SDK handshake spec).
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

// BIP-39 abandon × 11 + about. Well-known test vector; the derived
// addresses are publicly documented and never used for real funds.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');

const TEST_PASSWORD = 'TestPassword123!';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({
      path: path.resolve(RESULTS_DIR, `unisat-onboard-${name}.png`),
      fullPage: true,
    });
  } catch {
    // screenshots are diagnostic, never fatal
  }
}

async function dumpHtml(page: Page, name: string): Promise<void> {
  try {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 8000));
    fs.writeFileSync(path.resolve(RESULTS_DIR, `unisat-onboard-${name}.html`), html);
  } catch {
    // ignore
  }
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Unisat extension not unpacked at ${EXT_PATH}. ` +
      `Run e2e/playwright/playwright-bootstrap.sh unisat first.`,
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

test('restores a wallet from the BIP-39 test seed and reaches a screen mentioning send/receive/balance/account/bitcoin', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, {
    waitUntil: 'domcontentloaded',
  });

  // ─── Phase 1: welcome screen ───
  await expect(page.getByTestId('welcome-title')).toBeVisible({ timeout: 15_000 });
  await shot(page, '01-welcome');
  await dumpHtml(page, '01-welcome');

  // ─── Phase 2: "I already have a wallet" ───
  await page.getByTestId('import-wallet-button').click();
  await shot(page, '02-after-import-click');

  // ─── Phase 3: create password (twice) ───
  // Unisat asks for the wallet password BEFORE the mnemonic in the
  // import flow (CI screenshot 26366884942 / 02-after-import-click).
  await expect(page.getByTestId('create-password-input')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-confirm-input').fill(TEST_PASSWORD);
  await shot(page, '03-password-typed');

  await page.getByTestId('create-password-continue-button').click();
  await shot(page, '04-after-password-submit');

  // ─── Phase 4: pick "UniSat Wallet" as the source wallet to restore from ───
  // After password, Unisat asks "Choose a wallet you want to restore
  // from" (UniSat / Magic Eden / Xverse / Sparrow / Ordinals / Other).
  // The choice drives the BIP-44/49/84/86 derivation set Unisat scans.
  // value=0 is the UniSat Wallet entry, which gives BIP-84 native
  // segwit by default — matches our address assertion in iter 3.
  // (Source: ui.js T0=[{value:0,name:"UniSat Wallet",...}, ...].)
  await expect(page.getByTestId('restore-wallet-type-option-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('restore-wallet-type-option-0').click();
  await shot(page, '05-source-wallet-picked');

  // ─── Phase 5: fill the 12 mnemonic-word inputs ───
  // data-testid="mnemonic-import-word-0" through "...-11".
  await expect(page.getByTestId('mnemonic-import-word-0')).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await page.getByTestId(`mnemonic-import-word-${i}`).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await shot(page, '06-mnemonic-filled');

  await page.getByTestId('mnemonic-import-continue-button').click();
  await shot(page, '07-after-mnemonic-continue');

  // ─── Phase 6: address-type picker ───
  // Unisat v1.7.15 shows the address-type screen after mnemonic.
  // Native SegWit (BIP-84) is the default and the only path the
  // handshake spec verifies. The button MUST be clicked to advance
  // — if Unisat ever removes this screen, the spec needs an update,
  // not a silent skip.
  const addressTypeContinue = page.getByTestId('address-type-continue-button');
  await expect(addressTypeContinue).toBeVisible({ timeout: 15_000 });
  await shot(page, '08-address-type-picker');
  await addressTypeContinue.click();
  await shot(page, '09-after-address-type-continue');

  // ─── Phase 7: dismiss any post-restore notice ───
  // notice-popover has a checkbox + OK button on first dashboard
  // open. Best-effort: tick the checkbox if visible, click OK.
  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (await noticeCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await noticeCheckbox.click();
    const noticeOk = page.getByTestId('notice-ok-button');
    if (await noticeOk.isEnabled({ timeout: 3_000 }).catch(() => false)) {
      await noticeOk.click();
    }
    await shot(page, '10-notice-dismissed');
  }

  // ─── Phase 8: dashboard rendered ───
  // tab-home is the home tab on Unisat's bottom navigation. Its
  // presence proves the onboarding committed and the wallet is
  // unlocked.
  await expect(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
  await shot(page, '11-dashboard');

  // eslint-disable-next-line no-console
  console.log(`[unisat:onboard] dashboard renders (tab-home visible) — wallet committed.`);
  // eslint-disable-next-line no-console
  console.log(`[unisat:onboard] iteration 3 will verify the derived addresses via the SDK harness.`);
});
