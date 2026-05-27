import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { applyXverseVariant, XverseVariant } from '../xverse-vault';
import { waitForApprovalPopup } from '../approval-popup';
import { waitForChromeStorageKey, waitForSingletonLockGone } from '../wait-helpers';

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
  // chrome-extension:// page. Match by the visible Connect/Approve
  // button's role+name on the popup itself — no URL anchor (the
  // sats-connect surface URL has varied across Xverse builds).
  const approval = await waitForApprovalPopup({
    context,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first()
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
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
    // the MV3 service worker. No unlock, no settings UI, no tile
    // click — but we DO open the popup briefly so Xverse's SW boot
    // init runs to completion before we write. Without this, Xverse's
    // own startup writes default walletState AFTER ours, clobbering
    // the variant.
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
      let [w] = mutator.serviceWorkers();
      if (!w) w = await mutator.waitForEvent('serviceworker', { timeout: 30_000 });
      const xid = w.url().split('/')[2];
      // Open popup; wait for the unlock screen to render (proves
      // Xverse's React app + redux-persist have fully booted).
      // Don't unlock — we want redux-persist's debounce-save queue
      // to be empty when we close.
      const primer = await mutator.newPage();
      await primer.setViewportSize({ width: 400, height: 800 });
      await primer.goto(`chrome-extension://${xid}/popup.html`, { waitUntil: 'domcontentloaded' });
      await primer.waitForFunction(() => {
        const t = (document.body.innerText || '').toLowerCase();
        return t.includes('unlock') || t.includes('account 1');
      }, undefined, { timeout: 30_000, polling: 250 });
      await primer.close();
      // Gate on Xverse's redux-persist debounced save reaching
      // chrome.storage.local (walletState becomes a present key)
      // before we write the variant on top of it. Without the gate
      // the wallet boot-time save races ours and clobbers the variant.
      await waitForChromeStorageKey({ context: mutator, keyContains: 'walletState', timeoutMs: 30_000 });
      // Write the variant from the SW context. applyXverseVariant
      // returns a Phase-1 read-back so we can log it post-reload.
      const phase1Diag = await applyXverseVariant(mutator, variant);
      // eslint-disable-next-line no-console
      console.log(`[matrix:${variant.network}:${variant.paymentType}] Phase-1 read-back → legacy=${phase1Diag.phase1Legacy} keys=${JSON.stringify(phase1Diag.storageKeys)}`);
      // Gate the close on the variant write having materialised in
      // chrome.storage.local — applyXverseVariant resolves once the
      // SW evaluate returns, but redux-persist may still flush IDB
      // for a beat. Re-read by predicate to confirm.
      await waitForChromeStorageKey({
        context: mutator,
        keyContains: 'walletState',
        matchValue: v => typeof v === 'string' && v.includes(variant.network),
        timeoutMs: 30_000,
      });
      await mutator.close();
      // Wait for Chromium to release the user-data-dir before we
      // delete its lock files; rmSync against a still-locked dir
      // races on macOS / Linux.
      await waitForSingletonLockGone(workingDir).catch(() => undefined);
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

      // Diagnostic: read storage from SW BEFORE opening popup, so we
      // know whether walletState reverts at context launch or only
      // when the React app boots.
      const prePrimerLegacy = await worker.evaluate(async () => {
        const c = (globalThis as unknown as { chrome: { storage: { local: { get: (k: string, cb: (v: Record<string, string | undefined>) => void) => void } } } }).chrome;
        const raw = await new Promise<string | undefined>((r) => c.storage.local.get('persist:walletState', (v) => r(v['persist:walletState'])));
        if (!raw) return '<no walletState>';
        const state = JSON.parse(raw) as Record<string, string>;
        return state.btcPaymentAddressType ? JSON.parse(state.btcPaymentAddressType) : '<no btcPaymentAddressType>';
      });
      // eslint-disable-next-line no-console
      console.log(`[matrix:${variant.network}:${variant.paymentType}] Phase-2 pre-primer SW read → legacy=${prePrimerLegacy}`);

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

      // Regression assertions on Xverse's storage schema. If Xverse
      // changes the key names, the SOT key (zustand activeAccount vs
      // redux walletState), or the value encoding, these fail with
      // a sharper signal than the final paymentAddress mismatch.
      // Reasoning + recovery procedure in /Work/ordpool/WALLETS.md.
      expect(verify2.active, 'persistentStore::networks.value.active.bitcoin schema changed (see WALLETS.md)').toBe(variant.network);
      expect(verify2.activeAccountType, 'persistentStore::activeAccount.value.btcPaymentAddressType schema changed; the zustand SOT may have moved (see WALLETS.md)').toBe(variant.paymentType);
      expect(verify2.legacyType, 'persist:walletState.btcPaymentAddressType did not retain our write; the SW shutdown-flush race may have changed (see WALLETS.md)').toBe(variant.paymentType);

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
