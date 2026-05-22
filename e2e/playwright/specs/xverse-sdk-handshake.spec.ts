import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Iteration 3a — SDK ↔ Xverse handshake via sats-connect.
 *
 * After Iteration 2's onboarding spec commits a wallet to extension
 * storage, this spec loads the SDK harness page (HTML + bundled
 * connector/signer code served from http://localhost:4500), drives
 * our `xverseConnector.connect(Network.Testnet4)`, and asserts the
 * returned `paymentAddress` / `ordinalsAddress` match the well-known
 * BIP-84 / BIP-86 testnet derivations of the BIP-39 test seed
 * `abandon × 11 + about`.
 *
 * This proves:
 *   - the published Xverse extension responds to sats-connect calls
 *     made from a page loaded in our automated browser context
 *   - our SDK's xverseConnector code path parses the response into
 *     the expected WalletInfo shape
 *   - the address derivation Xverse uses matches the canonical
 *     BIP-84/86 path (so iteration 3c can re-encode to bcrt1 for
 *     the regtest mint roundtrip)
 *
 * Onboarding runs inline at the start of this spec (we don't
 * depend on test ordering with xverse-onboard.spec.ts; each spec
 * is responsible for its own wallet state).
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPassword123!';

// Iteration 3a doesn't pin the exact testnet addresses yet — different
// wallet implementations use different BIP-44/49/84/86 coin_type
// conventions (some use 1 for testnet, some reuse 0 for portable
// seeds). The first CI run logs the actual values; iteration 3b's
// commit hardcodes the verified strings.

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({
      path: path.resolve(RESULTS_DIR, `handshake-${name}.png`),
      fullPage: true,
    });
  } catch {
    // diagnostic only
  }
}

/**
 * The variable post-mnemonic phase: poll for whichever screen Xverse
 * lands on, react to it, repeat until "Wallet Restored" is visible.
 *
 * Why state-machine instead of sequential waits: the wallet picker
 * and address-type picker each appear in some runs but not others
 * (the widely-used BIP-39 test seed exposes different paths). Hard
 * `isVisible({timeout: 10000})` checks raced against rendering
 * timing and falsely returned `false` when the picker was about to
 * appear ~100ms later. Polling for any of the three concrete next
 * states is positive-assertion.
 */
type PostMnemonicState = 'picker' | 'address-type' | 'restored';

async function nextPostMnemonicState(page: Page): Promise<PostMnemonicState> {
  const handle = await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    if (t.includes('wallet restored')) return 'restored';
    if (t.includes('preferred address type')) return 'address-type';
    if (t.includes('select a wallet to restore') || t.includes('we found funds')) return 'picker';
    return false;
  }, undefined, { timeout: 120_000, polling: 250 });
  return handle.jsonValue() as Promise<PostMnemonicState>;
}

/**
 * Wait until a visible+enabled button with this exact text exists,
 * then click it. Returns the locator that was clicked so the caller
 * can verify state transitions.
 */
async function clickWhenEnabled(page: Page, text: string): Promise<void> {
  await page.waitForFunction((label: string) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(el => {
      if (el.textContent?.trim() !== label) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (el.hasAttribute('disabled')) return false;
      if (style.pointerEvents === 'none') return false;
      return true;
    });
  }, text, { timeout: 30_000, polling: 250 });
  const btn = page.getByRole('button', { name: text, exact: true }).first();
  await expect(btn).toBeVisible({ timeout: 5_000 });
  await btn.click();
}

/**
 * Click a button by exact text and positively poll that some
 * sentinel text DISAPPEARS from the page (= the click caused a
 * navigation/transition). Retries the click if the page doesn't
 * transition within 5s, up to `attempts` times.
 *
 * Catches the case where Xverse's React onClick fires but the
 * state update doesn't propagate in time, or where the click is
 * delivered to a stale button that re-rendered out from under
 * the click target.
 */
async function clickAndAwaitTransition(
  page: Page,
  buttonText: string,
  sentinelGoneRegex: RegExp,
  attempts = 3,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await clickWhenEnabled(page, buttonText);
    const transitioned = await page.waitForFunction(
      (re: string) => !(new RegExp(re, 'i')).test(document.body.innerText || ''),
      sentinelGoneRegex.source,
      { timeout: 5_000, polling: 250 },
    ).then(() => true).catch(() => false);
    if (transitioned) return;
  }
  throw new Error(`"${buttonText}" did not transition past "${sentinelGoneRegex}" after ${attempts} attempts`);
}

async function drivePostMnemonicFlow(page: Page): Promise<void> {
  const seen = new Set<PostMnemonicState>();
  for (;;) {
    const state = await nextPostMnemonicState(page);
    // eslint-disable-next-line no-console
    console.log(`[onboardXverse] post-mnemonic state: ${state}`);
    if (state === 'restored') return;
    if (seen.has(state)) {
      throw new Error(`onboardXverse stuck looping on state: ${state}`);
    }
    seen.add(state);

    if (state === 'picker') {
      await page.getByRole('button', { name: /see accounts/i }).first().click();
      await shot(page, `onb-picker-after-see-accounts`);
      await clickAndAwaitTransition(page, 'Confirm', /select a wallet to restore|we found funds/i);
      await shot(page, `onb-picker-after-confirm-click`);
    } else if (state === 'address-type') {
      await shot(page, `onb-address-type-screen`);
      await clickAndAwaitTransition(page, 'Continue', /preferred address type/i);
      await shot(page, `onb-address-type-after-continue`);
    }
  }
}

/**
 * Walks the Xverse onboarding flow (mirrors xverse-onboard.spec.ts
 * Phases 1-8). Kept inline so this spec doesn't take a dependency
 * on Playwright's between-spec state.
 */
async function onboardXverse(): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForFunction(
    () => {
      const t = (document.body.innerText || '').toLowerCase();
      return t.includes('restore') && t.includes('create');
    },
    { timeout: 30_000 },
  );

  await page.getByText(/restore an existing wallet|restore.*wallet/i).first().click();
  await expect(page.getByText(/legal/i).first()).toBeVisible({ timeout: 15_000 });

  const dc = page.getByText(/authorize data collection/i).first();
  if (await dc.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await dc.click();
  }
  await page.getByRole('button', { name: /^accept$/i }).first().click();

  const pws = page.locator('input[type="password"]');
  await expect(pws.first()).toBeVisible({ timeout: 15_000 });
  const pwCount = await pws.count();
  for (let i = 0; i < pwCount; i++) await pws.nth(i).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /continue|next|confirm|done|create/i }).first().click();

  await expect(page.getByText(/restore your wallet|what wallet are you importing/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByText(/^xverse$/i).first().click();

  await expect(page.getByText(/enter seed phrase/i).first()).toBeVisible({ timeout: 15_000 });
  const seedInputs = page.locator('input[type="password"]');
  await expect(seedInputs.first()).toBeVisible({ timeout: 10_000 });
  await seedInputs.first().click();
  await seedInputs.first().pressSequentially(TEST_MNEMONIC, { delay: 25 });

  await page.getByRole('button', { name: /continue|next|restore|confirm|done/i }).first().click();

  // State-machine for the variable phase between mnemonic-submit and
  // "Wallet Restored". After the chain scan, Xverse may show:
  //   - the wallet picker ("Select a wallet to restore") if the seed
  //     has multiple derivation histories
  //   - the address-type picker ("Preferred address type") if the
  //     wallet picker was skipped
  //   - "Wallet Restored" directly if both are skipped
  // We poll for the first concrete next-state signal, react, and
  // poll again until we land on "restored". No fixed timeouts on
  // intermediate "is this visible yet" checks.
  await drivePostMnemonicFlow(page);
  // Don't close the options.html tab; the harness page lives in
  // a separate tab in the same context and shares extension state.
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
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

  await onboardXverse();
});

test.afterAll(async () => {
  await context?.close();
});

test('xverseConnector.connect via the harness page returns the expected BIP-84/BIP-86 testnet addresses for the test seed', async () => {
  const page = await context.newPage();
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

  // Wait for the SDK harness bundle to run + set its ready flag.
  await page.waitForFunction(() => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true, { timeout: 15_000 });
  await shot(page, '01-harness-loaded');

  // sats-connect's getAddress triggers Xverse to open its approval
  // UI in a separate extension window (chrome-extension:// origin),
  // not the harness page. Listen for the new page; when it appears,
  // click whatever Approve/Connect/Confirm button it renders.
  const approvalPage: Promise<Page> = context.waitForEvent('page', { timeout: 30_000 });
  const resultPromise = page.evaluate(() => window.ordpoolSdkHarness.connectXverse('testnet4'));

  const approval = await approvalPage;
  await approval.waitForLoadState('domcontentloaded');
  await shot(approval, '02a-approval-page');
  // Approve via state-machine: wait for one of the known consent
  // labels to appear, then click. Like the onboarding flow, this
  // is positive-poll, not blind-timeout.
  await approval.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return ['connect', 'approve', 'confirm', 'allow'].some(s => t.includes(s));
  }, undefined, { timeout: 30_000, polling: 250 });
  // Find the first visible, enabled button matching one of the
  // consent labels.
  const consentBtn = approval.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first();
  await expect(consentBtn).toBeVisible({ timeout: 5_000 });
  await consentBtn.click();
  await shot(approval, '02b-after-approve');

  const info = await resultPromise;
  // eslint-disable-next-line no-console
  console.log(`[xverse:sdk-handshake] payment  = ${info.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[xverse:sdk-handshake] ordinals = ${info.ordinalsAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[xverse:sdk-handshake] payment.pubkey  = ${info.paymentPublicKey}`);
  // eslint-disable-next-line no-console
  console.log(`[xverse:sdk-handshake] ordinals.pubkey = ${info.ordinalsPublicKey}`);
  await shot(page, '03-after-connect');

  expect(info.signingSupported).toBe(true);
  // Payment address is BIP-84 native SegWit on testnet → tb1q...
  expect(info.paymentAddress).toMatch(/^tb1q[ac-hj-np-z02-9]{39,}$/);
  // Ordinals address is BIP-86 Taproot on testnet → tb1p...
  expect(info.ordinalsAddress).toMatch(/^tb1p[ac-hj-np-z02-9]{58,}$/);
  // Pubkeys are hex; payment compressed = 66 chars, ordinals x-only = 64.
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
  expect(info.ordinalsPublicKey).toMatch(/^[0-9a-f]{64}$/);
});
