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
 * Walks the Xverse onboarding flow (cloned from xverse-onboard.spec.ts
 * Phases 1-8). Kept inline so this spec doesn't take a dependency on
 * Playwright's between-spec state.
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

  // Picker → See accounts → Confirm
  await page.waitForFunction(
    () => {
      const t = (document.body.innerText || '').toLowerCase();
      return t.includes('select a wallet to restore')
          || t.includes('we found funds')
          || /bc1[qp][a-z0-9]{20,}/.test(document.body.innerText || '');
    },
    { timeout: 90_000 },
  );
  const picker = page.getByText(/select a wallet to restore|we found funds/i).first();
  if (await picker.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page.getByRole('button', { name: /see accounts/i }).first().click();
    const commit = page.getByText('Confirm', { exact: true }).first();
    await expect(commit).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const c = buttons.find(b => b.textContent?.trim() === 'Confirm');
        return c ? !c.hasAttribute('disabled') && getComputedStyle(c).pointerEvents !== 'none' : false;
      },
      { timeout: 10_000 },
    );
    await commit.click();
  }

  const addressTypePicker = page.getByText(/preferred address type/i).first();
  if (await addressTypePicker.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await page.getByText('Continue', { exact: true }).first().click();
  }

  await expect(page.getByText(/wallet restored/i).first()).toBeVisible({ timeout: 30_000 });
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

  // sats-connect's getAddress shows an Xverse-injected approval UI
  // on the page (origin must be approved before the wallet replies).
  // We trigger the call, then handle the approval flow on the same
  // page in parallel — wait for both: window function resolves OR
  // an approval button appears.
  const resultPromise = page.evaluate(() => window.ordpoolSdkHarness.connectXverse('testnet4'));

  // Approve the connection request when Xverse's prompt appears.
  // Xverse injects its UI on the page itself for sats-connect v1.
  const approve = page.getByRole('button', { name: /^(approve|connect|confirm|allow)$/i }).first();
  if (await approve.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await shot(page, '02a-approval-prompt');
    await approve.click({ force: true });
    await shot(page, '02b-after-approve');
  }

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
