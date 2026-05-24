import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { applyXverseVariant, XverseVariant } from '../xverse-vault';

/**
 * Matrix coverage for every Xverse Network × Payment-Address-Type
 * combination. Each test:
 *
 *   1. Clones the click-onboarded seed dir from globalSetup.
 *   2. Launches Chromium, unlocks the wallet with the test password.
 *   3. Calls `applyXverseVariant` to mutate the cloned chrome.storage
 *      into the target combination (active network + payment type).
 *   4. Reloads the extension via chrome.runtime.reload so the new
 *      values take effect, re-unlocks.
 *   5. Drives `xverseConnector.connect()` via the SDK harness and
 *      asserts the returned paymentAddress matches the expected
 *      derivation for the test seed `abandon × 11 + about`.
 *
 * Signet is skipped — Xverse's onboarding doesn't pre-populate the
 * Signet btcAddresses for our test seed (the dump shows Signet:[]),
 * and we don't compute them at runtime. Re-add when we have a
 * deterministic derivation in xverse-vault.ts.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/xverse');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';
const TEST_PASSWORD = 'TestPassword123!';
const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../../test-results/xverse-seed-user-data-dir');

// BIP-49/84/86 derivations of the BIP-39 test seed `abandon × 11 +
// about` at account 0 / index 0, per the click-onboarded dump. The
// SDK signs against these; this spec just asserts the wallet
// returns each variant correctly.
const EXPECTED: Record<string, Record<string, string>> = {
  'bitcoin-mainnet':  { native: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',  nested: '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf' },
  'bitcoin-testnet4': { native: 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl',  nested: '2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2' },
  'bitcoin-regtest':  { native: 'bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk', nested: '2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2' },
};

// Matrix that maps to user-pickable Xverse combinations we care
// about. Mainnet and Regtest are the only networks exercised
// (testnet3/4 + signet are explicitly out of scope per WALLETS.md).
// Both payment-address types are exercised on both networks.
const VARIANTS: ReadonlyArray<XverseVariant> = [
  { network: 'bitcoin-mainnet',  paymentType: 'native' },
  { network: 'bitcoin-mainnet',  paymentType: 'nested' },
  { network: 'bitcoin-regtest',  paymentType: 'native' },
  { network: 'bitcoin-regtest',  paymentType: 'nested' },
];


async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.resolve(RESULTS_DIR, `matrix-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function unlockWallet(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('unlock') || t.includes('account 1');
  }, undefined, { timeout: 30_000, polling: 250 });
  if (/unlock/i.test(await page.locator('body').innerText())) {
    await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /^unlock$/i }).first().click();
    await page.waitForFunction(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return t.includes('account 1') || t.includes('not now') || t.includes('zest') || t.includes('send');
    }, undefined, { timeout: 30_000, polling: 250 });
  }
  const notNow = page.getByText('Not now', { exact: true }).first();
  if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await notNow.click({ force: true }).catch(() => undefined);
  }
}

async function approveSatsConnectInline(context: BrowserContext, knownPages: Set<Page>): Promise<void> {
  // sats-connect getAddress opens an approval popup on a new
  // chrome-extension:// page. Wait, find the "Connect"/"Approve"
  // button, click. Same pattern xverse-sdk-handshake uses.
  const deadline = Date.now() + 60_000;
  let approval: Page | undefined;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (knownPages.has(p)) continue;
      if (!p.url().startsWith('chrome-extension://')) continue;
      const text = await p.locator('body').innerText().catch(() => '');
      if (/^(connect|approve|confirm|allow)$/im.test(text)) {
        approval = p;
        break;
      }
    }
    if (approval) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!approval) throw new Error('sats-connect approval popup never showed Connect button');
  await approval.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first().click({ force: true });
}


test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }
  if (!fs.existsSync(path.join(SEED_USER_DATA_DIR, 'Default'))) {
    throw new Error(`Xverse seed dir missing at ${SEED_USER_DATA_DIR}. globalSetup must have produced it.`);
  }
});


for (const variant of VARIANTS) {
  test(`SDK returns the right paymentAddress for ${variant.network} + ${variant.paymentType}`, async () => {
    test.setTimeout(120_000);

    const workingDir = `${SEED_USER_DATA_DIR}.matrix-${variant.network}-${variant.paymentType}-${process.pid}-${Date.now()}`;
    fs.cpSync(SEED_USER_DATA_DIR, workingDir, { recursive: true });
    for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      fs.rmSync(path.join(workingDir, stale), { force: true });
    }

    // Phase 1 — variant setup via direct chrome.storage writes from
    // the MV3 service worker. No popup, no unlock, no UI click —
    // popup never boots, so redux-persist can't overwrite our values.
    {
      const mutator = await chromium.launchPersistentContext(workingDir, {
        headless: false,
        args: [
          `--disable-extensions-except=${EXT_PATH}`,
          `--load-extension=${EXT_PATH}`,
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      });
      await applyXverseVariant(mutator, variant);
      // Give chromium time to flush the leveldb writes before close.
      await new Promise(r => setTimeout(r, 3_000));
      await mutator.close();
      await new Promise(r => setTimeout(r, 2_000));
      for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        fs.rmSync(path.join(workingDir, stale), { force: true });
      }
    }

    // Phase 2 — the actual test context, launched against the dir
    // with the variant baked in.
    const context = await chromium.launchPersistentContext(workingDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    try {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
      const extensionId = worker.url().split('/')[2];

      const primer = await context.newPage();
      await primer.setViewportSize({ width: 400, height: 800 });
      await primer.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
      // Verify storage survived the close+relaunch. Check both stores.
      const verify2 = await primer.evaluate(() => new Promise<{ active: string; activeAccountType: string; legacyType: string }>((resolve) => {
        const c = (window as unknown as { chrome: { storage: { local: { get: (k: string[], cb: (v: Record<string, string>) => void) => void } } } }).chrome;
        c.storage.local.get(['persistentStore::networks', 'persistentStore::activeAccount', 'persist:walletState'], (v) => {
          const net = JSON.parse(v['persistentStore::networks']);
          const acc = v['persistentStore::activeAccount'] ? JSON.parse(v['persistentStore::activeAccount']) : { value: { btcPaymentAddressType: '<missing>' } };
          const state = JSON.parse(v['persist:walletState']);
          resolve({
            active: net.value.active.bitcoin,
            activeAccountType: acc.value.btcPaymentAddressType,
            legacyType: JSON.parse(state.btcPaymentAddressType),
          });
        });
      }));
      // eslint-disable-next-line no-console
      console.log(`[matrix:${variant.network}:${variant.paymentType}] test-context reads → active=${verify2.active} activeAccount=${verify2.activeAccountType} legacy=${verify2.legacyType}`);
      await unlockWallet(primer);
      await shot(primer, `${variant.network}-${variant.paymentType}-dashboard`);

      // Drive the SDK harness for the address.
      const harness = await context.newPage();
      await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
      await harness.waitForFunction(() => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true, { timeout: 15_000 });

      const networkArg = variant.network === 'bitcoin-mainnet' ? 'mainnet'
        : variant.network === 'bitcoin-testnet4' ? 'testnet4'
        : 'regtest';
      const knownPages = new Set(context.pages());
      const resultPromise = harness.evaluate((n) => window.ordpoolSdkHarness.connectXverse(n), networkArg as 'mainnet' | 'testnet4' | 'regtest');
      await approveSatsConnectInline(context, knownPages);
      const info = await resultPromise;

      // eslint-disable-next-line no-console
      console.log(`[matrix] ${variant.network} + ${variant.paymentType} → payment = ${info.paymentAddress}`);
      const expected = EXPECTED[variant.network][variant.paymentType];
      expect(info.paymentAddress).toBe(expected);
    } finally {
      await context.close();
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });
}
