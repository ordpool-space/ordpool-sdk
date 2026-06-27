import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';

/**
 * Pipeline B: SDK → Unisat onAccountChange end-to-end.
 *
 * Verifies that when the user switches network INSIDE the wallet,
 * our `unisatConnector.onAccountChange` callback fires AND the
 * SDK's re-connect returns the new address (different from the
 * mainnet one).
 *
 * Driver: `window.unisat.switchNetwork('testnet')`. Documented
 * programmatic API; Unisat emits the `networkChanged` event the
 * connector subscribes to. The event MAY trigger an approval popup
 * depending on the wallet's per-origin permission state; we handle
 * both the popup-required and instant-switch paths.
 *
 * Test seed BIP-84 derivations:
 *   m/84'/0'/0'/0/0  → bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu  (mainnet)
 *   m/84'/1'/0'/0/0  → tb1qcr8te4kr609gcawutmrza0j4xv80jy8z9c0xk0  (testnet)
 * The post-switch paymentAddress must change to the tb1q… form.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/unisat');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const EXPECTED_MAINNET_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({
      path: path.resolve(RESULTS_DIR, `unisat-account-change-${name}.png`),
      fullPage: true,
    });
  } catch { /* diagnostic, never fatal */ }
}

async function onboardUnisat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('welcome-title')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('import-wallet-button').click();

  await expect(page.getByTestId('create-password-input')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-confirm-input').fill(TEST_PASSWORD);
  await page.getByTestId('create-password-continue-button').click();

  await expect(page.getByTestId('restore-wallet-type-option-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('restore-wallet-type-option-0').click();

  await expect(page.getByTestId('mnemonic-import-word-0')).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
    await page.getByTestId(`mnemonic-import-word-${i}`).fill(TEST_MNEMONIC_WORDS[i]);
  }
  await page.getByTestId('mnemonic-import-continue-button').click();

  await expect(page.getByTestId('address-type-continue-button')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('address-type-continue-button').click();

  const noticeCheckbox = page.getByTestId('notice-checkbox-1');
  if (await noticeCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await noticeCheckbox.click();
    const noticeOk = page.getByTestId('notice-ok-button');
    if (await noticeOk.isEnabled({ timeout: 3_000 }).catch(() => false)) {
      await noticeOk.click();
    }
  }

  await expect(page.getByTestId('tab-home')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Unisat extension not unpacked at ${EXT_PATH}.`);
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

  const onboardPage = await context.newPage();
  await onboardUnisat(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('onAccountChange fires when window.unisat.switchNetwork("testnet") is called; reconnect returns the testnet address', async () => {
  test.setTimeout(120_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // 1. Initial connect — accept the approval popup.
  const connectKnownPages = new Set(context.pages());
  const initialConnectPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectUnisat());

  const connectApproval = await waitForApprovalPopup({
    context,
    knownPages: connectKnownPages,
    isApproval: async (p) => {
      await p.waitForURL(/notification\.html#\/approval/, { timeout: 60_000 });
      return true;
    },
  });
  await shot(connectApproval, '02a-connect-approval');
  await connectApproval.getByText(/^Connect$/).first().click();

  const initialInfo = await initialConnectPromise;
  // eslint-disable-next-line no-console
  console.log(`[unisat:account-change] initial paymentAddress = ${initialInfo.paymentAddress}`);
  expect(initialInfo.paymentAddress).toBe(EXPECTED_MAINNET_ADDRESS);
  await shot(harness, '02b-connected-mainnet');

  // 2. Arm the account-change probe BEFORE triggering the change.
  //    The harness method subscribes via onAccountChange, then
  //    re-connects when the event fires, and resolves the promise
  //    with the new WalletInfo.
  const probePromise = harness.evaluate(() => window.ordpoolSdkHarness.armUnisatAccountChangeProbe());

  // 3. Trigger the network switch. Per Unisat's docs:
  //    `await window.unisat.switchNetwork('testnet')` switches the
  //    active Bitcoin network and emits `networkChanged`. The call
  //    MAY surface an approval popup depending on the wallet's
  //    per-origin permission cache; handle both branches.
  const switchKnownPages = new Set(context.pages());
  const switchCallPromise = harness.evaluate(() =>
    (window as unknown as { unisat: { switchNetwork(net: string): Promise<unknown> } })
      .unisat.switchNetwork('testnet')
  );

  // Race the popup against the call resolving. If the call resolves
  // first (no popup needed), there's nothing to click. If a popup
  // appears, approve it.
  const popupOrCallSettled = await Promise.race([
    waitForApprovalPopup({
      context,
      knownPages: switchKnownPages,
      isApproval: async (p) => {
        await p.waitForURL(/notification\.html#\/approval/, { timeout: 10_000 });
        return true;
      },
    }).then(p => ({ kind: 'popup' as const, page: p })),
    switchCallPromise.then(() => ({ kind: 'settled' as const })),
  ]).catch(() => ({ kind: 'settled' as const }));

  if (popupOrCallSettled.kind === 'popup') {
    await shot(popupOrCallSettled.page, '03a-switch-approval');
    // Unisat's switch-network approval also renders Connect/Confirm
    // as styled <div>s. Match by text — `Confirm`, `Connect`,
    // `Switch`, and `Switch Network` all appear across versions
    // (the network-switch dialog was relabeled "Switch Network"
    // around Unisat v1.7.x — see screenshot 03a-switch-approval).
    const confirmBtn = popupOrCallSettled.page.getByText(/^(Confirm|Connect|Switch( Network)?)$/).first();
    await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
    await confirmBtn.click();
    await shot(popupOrCallSettled.page, '03b-switch-approved');
    await switchCallPromise; // settle now
  }

  // 4. Wait for the onAccountChange callback → re-connect → new WalletInfo.
  const updatedInfo = await probePromise;
  // eslint-disable-next-line no-console
  console.log(`[unisat:account-change] post-switch paymentAddress = ${updatedInfo.paymentAddress}`);
  await shot(harness, '04-after-account-change');

  // 5. Assertions. The new paymentAddress must:
  //    - be different from the initial mainnet address
  //    - have the testnet bech32 prefix (`tb1q…`)
  expect(updatedInfo.paymentAddress).not.toBe(EXPECTED_MAINNET_ADDRESS);
  expect(updatedInfo.paymentAddress.startsWith('tb1q')).toBe(true);

  // Bonus: the SDK's network-mismatch helper should classify
  // accordingly. If a consumer wired isAddressCompatibleWithNetwork
  // against the mainnet group, the new address would fail the gate.
  // (We don't import the helper into the spec; instead we assert the
  // address shape that drives it.)
});
