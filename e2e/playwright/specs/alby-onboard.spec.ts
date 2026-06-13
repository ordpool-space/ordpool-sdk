import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';


/**
 * Onboard smoke test for Alby. Alby's UI is Lightning-first and
 * exposes no BIP-39 input path through the welcome wizard; the
 * "Find Your Wallet" flow leads to an LND / Core Lightning / NWC
 * picker, not a mnemonic restore.
 *
 * The actual mnemonic-import path Alby ships uses internal SW
 * router actions (setPassword / addAccount / setMnemonic). That
 * envelope was reverse-engineered for the mint roundtrip spec —
 * this test re-uses the same envelope as a focused smoke test:
 * if Alby ever renames an action or changes its message shape,
 * this short fast test will catch it before the heavy mint spec
 * even runs.
 *
 * Coverage:
 *   - SW responds to setPassword with {data: {unlocked: true}}
 *   - SW responds to addAccount with a non-empty accountId
 *   - SW responds to setMnemonic echoing the same accountId
 *   - After seeding, alby.webbtc.getAddress() returns the seeded
 *     mainnet Taproot address
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPassword123!';

// BIP-86 mainnet first-receiving address for the abandon×11+about
// seed at m/86'/0'/0'/0/0. Same value used by alby-sdk-handshake.
const EXPECTED_MAINNET_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

let context: BrowserContext;
let extensionId: string;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-onboard-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Alby extension not unpacked at ${EXT_PATH}.`);
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

test('restores a wallet from the BIP-39 test seed via SW-message envelope and derives the expected mainnet Taproot address', async () => {
  test.setTimeout(180_000);

  const seedPage = await context.newPage();
  // Block window.close so options.html survives Alby's React
  // welcome wizard (which calls window.close() on first paint).
  await seedPage.addInitScript(() => {
    try {
      Object.defineProperty(window, 'close', { value: () => undefined, writable: false, configurable: false });
    } catch { /* ignore */ }
  });
  await seedPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  await seedPage.waitForFunction(() => true, undefined, { timeout: 2_000 }).catch(() => undefined);
  await shot(seedPage, '00-options');

  // Seed via internal SW actions in one page.evaluate.
  const seed = await seedPage.evaluate(async ({ password, mnemonic }) => {
    const c = (globalThis as unknown as { chrome: { runtime: {
      sendMessage: (msg: unknown) => Promise<unknown>;
    } } }).chrome;
    const send = (action: string, args: Record<string, unknown>) =>
      c.runtime.sendMessage({
        application: 'LBE',
        prompt: true,
        action,
        args,
        origin: { internal: true },
      }) as Promise<{ data?: unknown; error?: string } | null>;

    const setPwResp = await send('setPassword', { password }) as { data?: { unlocked?: boolean }; error?: string } | null;
    const addAccResp = await send('addAccount', {
      name: 'ordpool-onboard',
      connector: 'lndhub',
      config: { url: 'https://example.invalid', login: 'x', password: 'x' },
      bitcoinNetwork: 'bitcoin',
    }) as { data?: { accountId?: string }; error?: string } | null;
    const accountId = addAccResp?.data?.accountId;
    const setMnemoResp = accountId
      ? await send('setMnemonic', { id: accountId, mnemonic }) as { data?: { accountId?: string }; error?: string } | null
      : null;
    return { setPwResp, addAccResp, setMnemoResp, accountId };
  }, { password: TEST_PASSWORD, mnemonic: TEST_MNEMONIC });

  // eslint-disable-next-line no-console
  console.log(`[alby-onboard] seed = ${JSON.stringify(seed)}`);
  await shot(seedPage, '01-after-seed');

  // Envelope shape pins.
  expect(seed.setPwResp?.data?.unlocked).toBe(true);
  expect(seed.accountId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(seed.setMnemoResp?.data?.accountId).toBe(seed.accountId);

  // Cross-check the seeded mnemonic actually drives the documented
  // BIP-86 derivation by reading the address from a regular tab via
  // the public alby.webbtc API. We need to auto-click any Alby
  // popups that appear (alby.enable() permission, getAddress
  // confirmation).
  context.on('page', async (popup) => {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      if (!popup.url().startsWith('chrome-extension://')) return;
      await popup.waitForTimeout(6_000);
      const btn = popup.locator('button', { hasText: /^(connect|allow|confirm|approve)$/i }).first();
      await btn.waitFor({ state: 'visible', timeout: 5_000 });
      await btn.click({ timeout: 5_000 });
    } catch { /* swallow; we just want best-effort approve */ }
  });

  const probePage = await context.newPage();
  await probePage.goto('http://localhost:4500/', { waitUntil: 'domcontentloaded' });

  const address = await probePage.evaluate(async () => {
    interface WebBtc { enable?(): Promise<void>; getAddress(): Promise<{ address: string } | string> }
    interface AlbyApi { enable(): Promise<void>; webbtc: WebBtc }
    const alby = (window as unknown as { alby: AlbyApi }).alby;
    await alby.enable();
    if (alby.webbtc.enable) await alby.webbtc.enable();
    const res = await alby.webbtc.getAddress();
    return typeof res === 'string' ? res : res.address;
  });
  // eslint-disable-next-line no-console
  console.log(`[alby-onboard] derived address = ${address}`);

  expect(address).toBe(EXPECTED_MAINNET_TAPROOT);
});
