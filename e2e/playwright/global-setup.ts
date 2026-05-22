import { chromium } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { buildXverseVault } from './xverse-vault';

/**
 * Playwright globalSetup — runs ONCE before any spec.
 *
 * Produces a chromium user-data-dir seeded with an already-
 * onboarded Xverse wallet on Bitcoin Regtest. Specs clone the
 * dir, launch with it, enter the password to unlock, and skip
 * the entire ~25s onboarding click-flow.
 *
 * The wallet state is constructed deterministically from
 * (TEST_MNEMONIC, TEST_PASSWORD) by `buildXverseVault` — see
 * that module's header for the reversed encryption pipeline.
 * No browser-driven onboarding step needed.
 *
 * The onboarding click-flow is still exercised by
 * `specs/xverse-onboard.spec.ts` as an end-to-end smoke test.
 */

const EXT_PATH = path.resolve(__dirname, '../extensions/xverse');
export const SEED_USER_DATA_DIR = process.env.XVERSE_SEED_USER_DATA_DIR
  ?? path.resolve(__dirname, '../../test-results/xverse-seed-user-data-dir');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPassword123!';

/**
 * Pre-build the `persistentStore::networks` JSON that selects
 * Bitcoin Regtest as the active chain. Configurations mirror the
 * built-ins shipped with Xverse v2.3.2; the SDK doesn't write any
 * custom networks here, so the wallet boots on the bundled
 * Regtest config (electrsApiUrl points at sBTC mempool by
 * default; we override at runtime via chrome.storage in spec3 if
 * we need to point at a local electrs).
 */
function buildNetworksJson(): string {
  return JSON.stringify({
    value: {
      active: {
        bitcoin: 'bitcoin-regtest',
        spark:   'spark-regtest',
        stacks:  'stacks-testnet',
        starknet:'starknet-sepolia',
      },
      configurations: [
        { id: 'bitcoin-mainnet',  source: 'builtin', chain: 'bitcoin',  mode: 'mainnet',  name: 'Mainnet',  xverseApiUrl: 'https://api-3.xverse.app',         electrsApiUrl: 'https://btc-1.xverse.app' },
        { id: 'bitcoin-testnet4', source: 'builtin', chain: 'bitcoin',  mode: 'testnet4', name: 'Testnet4', xverseApiUrl: 'https://api-testnet4.xverse.app',  electrsApiUrl: 'https://btc-testnet4.xverse.app' },
        { id: 'bitcoin-signet',   source: 'builtin', chain: 'bitcoin',  mode: 'signet',   name: 'Signet',   xverseApiUrl: 'https://api-signet.xverse.app',    electrsApiUrl: 'https://btc-signet.xverse.app' },
        { id: 'bitcoin-regtest',  source: 'builtin', chain: 'bitcoin',  mode: 'regtest',  name: 'Regtest',  xverseApiUrl: 'https://api-signet.xverse.app',    electrsApiUrl: 'https://beta.sbtc-mempool.tech/api/proxy' },
        { id: 'spark-mainnet',    source: 'builtin', chain: 'spark',    mode: 'mainnet',  name: 'Mainnet',                                                    electrsApiUrl: 'https://btc-1.xverse.app' },
        { id: 'spark-regtest',    source: 'builtin', chain: 'spark',    mode: 'regtest',  name: 'Regtest',                                                    electrsApiUrl: 'https://beta.sbtc-mempool.tech/api/proxy' },
        { id: 'stacks-mainnet',   source: 'builtin', chain: 'stacks',   mode: 'mainnet',  name: 'Mainnet',  stacksApiUrl: 'https://api.hiro.so',              xverseApiUrl: 'https://api-3.xverse.app' },
        { id: 'stacks-testnet',   source: 'builtin', chain: 'stacks',   mode: 'testnet',  name: 'Testnet',  stacksApiUrl: 'https://api.testnet.hiro.so',      xverseApiUrl: 'https://api-testnet4.xverse.app' },
        { id: 'starknet',         source: 'builtin', chain: 'starknet', mode: 'mainnet',  name: 'Mainnet',  rpcApiUrl: 'https://api-3.xverse.app/starknet/v2/rpc',        xverseApiUrl: 'https://api-3.xverse.app' },
        { id: 'starknet-sepolia', source: 'builtin', chain: 'starknet', mode: 'sepolia',  name: 'Sepolia',  rpcApiUrl: 'https://api-testnet4.xverse.app/starknet/v2/rpc', xverseApiUrl: 'https://api-testnet4.xverse.app' },
      ],
    },
    version: 1,
  });
}

export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Xverse extension not unpacked at ${EXT_PATH}. Run e2e/playwright/playwright-bootstrap.sh.`);
  }

  if (
    fs.existsSync(path.join(SEED_USER_DATA_DIR, 'Default')) &&
    !process.env.XVERSE_FORCE_REONBOARD
  ) {
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] reusing existing seed user-data-dir at ${SEED_USER_DATA_DIR}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[globalSetup] generating Xverse vault deterministically from test mnemonic…`);
  const vaultBlob = buildXverseVault(TEST_MNEMONIC, TEST_PASSWORD);
  const seededStorage = {
    ...vaultBlob,
    'persistentStore::networks': buildNetworksJson(),
  };

  fs.rmSync(SEED_USER_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(SEED_USER_DATA_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(SEED_USER_DATA_DIR, {
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
  const extensionId = worker.url().split('/')[2];

  try {
    const seeder = await context.newPage();
    await seeder.setViewportSize({ width: 400, height: 800 });
    await seeder.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await seeder.evaluate((data) => new Promise<void>((resolve, reject) => {
      const c = (window as unknown as { chrome: { storage: { local: { set: (d: Record<string, unknown>, cb: () => void) => void } }; runtime: { lastError?: { message: string } } } }).chrome;
      c.storage.local.set(data, () => {
        if (c.runtime.lastError) reject(new Error(c.runtime.lastError.message));
        else resolve();
      });
    }), seededStorage);
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] injected ${Object.keys(seededStorage).length} storage keys`);

    // Force Xverse to actually rehydrate from disk so it writes
    // back the additional state it derives on first unlock
    // (account list, auth tokens, redux-persist defaults). Without
    // this, specs cloning the dir see the loading spinner forever
    // post-unlock because the bootstrap state isn't persisted yet.
    await seeder.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await seeder.waitForFunction(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return t.includes('unlock') || t.includes('account 1') || t.includes('create') || t.includes('restore');
    }, undefined, { timeout: 30_000, polling: 250 });
    if (/unlock/i.test(await seeder.locator('body').innerText())) {
      await seeder.locator('input[type="password"]').first().fill(TEST_PASSWORD);
      await seeder.getByRole('button', { name: /^unlock$/i }).first().click();
      // Wait for the dashboard signals; tolerate slow network init.
      await seeder.waitForFunction(() => {
        const t = (document.body.innerText || '').toLowerCase();
        return t.includes('account 1') || t.includes('not now') || t.includes('zest') || t.includes('send');
      }, undefined, { timeout: 60_000, polling: 250 }).catch(() => {
        // eslint-disable-next-line no-console
        console.log('[globalSetup] post-unlock dashboard text not seen within 60s; continuing anyway');
      });
    }
    // Give chromium / extension a beat to finish writing any
    // post-unlock state, then flush to leveldb on close.
    await new Promise(r => setTimeout(r, 5_000));
    await seeder.close().catch(() => undefined);
  } finally {
    await context.close();
  }
  await new Promise(r => setTimeout(r, 2_000));
  // eslint-disable-next-line no-console
  console.log(`[globalSetup] seed user-data-dir ready at ${SEED_USER_DATA_DIR}`);
}
