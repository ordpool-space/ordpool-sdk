import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { onboardPhantom } from '../onboard-phantom';

/**
 * Inscribe-roundtrip spec for Phantom — mirrors the structure of
 * `phantom-mint-roundtrip.spec.ts`. Phantom v26.x ships
 * `window.phantom.bitcoin` dormant: the in-page provider object IS
 * defined, but the underlying service-worker handlers for
 * `btc_requestAccounts` and friends are not. dApp-side BTC support
 * is structurally absent on the current Chrome Web Store builds.
 *
 * Pipeline B can't drive a full inscribe roundtrip without those SW
 * handlers, so this spec pins the *current* state of Phantom: connect
 * rejects with "btc_requestAccounts isn't implemented", which means
 * the inscribe roundtrip is blocked at the same step the mint is
 * blocked. When Phantom enables the BTC handlers, this test flips
 * red and we know to rewrite it as a real roundtrip.
 *
 * Per the SDK CLAUDE.md "Ship every signer we have code for" rule,
 * the Phantom inscribe signer ships unmodified — only the e2e
 * coverage is degraded by the wallet's current state.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/phantom');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `phantom-inscribe-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Phantom extension not unpacked at ${EXT_PATH}.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }

  fs.writeFileSync(
    path.join(EXT_PATH, '__ordpool_unlock__.html'),
    '<!DOCTYPE html><html><head><title>ordpool-e2e-unlock</title></head><body>ordpool-e2e</body></html>',
  );

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--unsafely-treat-insecure-origin-as-secure=http://localhost:4500`,
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = worker.url().split('/')[2];

  let onboardPage: Page;
  try {
    onboardPage = await context.waitForEvent('page', {
      predicate: p => p.url().startsWith(`chrome-extension://${extensionId}`),
      timeout: 15_000,
    });
  } catch {
    onboardPage = await context.newPage();
  }
  test.setTimeout(240_000);
  await onboardPhantom(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded').catch(() => undefined);

  const unlockPage = await context.newPage();
  await unlockPage.goto(
    `chrome-extension://${extensionId}/__ordpool_unlock__.html`,
    { waitUntil: 'domcontentloaded' },
  );
  const smInfo = await unlockPage.evaluate(() => {
    const c = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome;
    const sm = c?.runtime?.sendMessage;
    return { available: typeof sm === 'function' };
  }).catch(() => ({ available: false }));
  if (smInfo.available) {
    await unlockPage.evaluate(async (pwd: string) => {
      try {
        const c = (globalThis as unknown as { chrome: { runtime: {
          sendMessage: (msg: unknown) => Promise<unknown>;
        } } }).chrome;
        await c.runtime.sendMessage(JSON.stringify({ method: 'unlockExtension', params: pwd, id: 1 }));
      } catch { /* swallow */ }
    }, 'TestPassword123!');
    await unlockPage.evaluate(async () => {
      try {
        const c = (globalThis as unknown as { chrome: { scripting: {
          registerContentScripts: (s: unknown[]) => Promise<void>;
          unregisterContentScripts: (o: { ids: string[] }) => Promise<void>;
        } } }).chrome;
        await c.scripting.unregisterContentScripts({ ids: ['ordpool_btc_inject'] }).catch(() => undefined);
        await c.scripting.registerContentScripts([{
          id: 'ordpool_btc_inject',
          matches: ['http://localhost:4500/*'],
          js: ['btc.js'],
          runAt: 'document_start',
          allFrames: true,
          world: 'MAIN',
        }]);
      } catch { /* swallow */ }
    });
  }
  await unlockPage.close().catch(() => undefined);
});

test.afterAll(async () => {
  await context?.close();
});

test('phantom v26.x: inscribe cannot proceed — connect step rejects because the SW has no btc_* handlers', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await harness.reload({ waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  const phantomVisible = await harness.evaluate(() => {
    const p = (window as unknown as { phantom?: { bitcoin?: unknown } }).phantom;
    return { hasPhantom: !!p, hasBitcoin: !!p?.bitcoin };
  });
  expect(phantomVisible.hasPhantom).toBe(true);
  expect(phantomVisible.hasBitcoin).toBe(true);

  const connectOutcome = await harness.evaluate(async () => {
    try {
      const info = await window.ordpoolSdkHarness.connectPhantom();
      return { ok: true, info };
    } catch (e) {
      return { ok: false, err: String((e as Error).message || e) };
    }
  });
  expect(connectOutcome.ok).toBe(false);
  expect(connectOutcome.err).toMatch(/btc_requestAccounts isn't implemented|not permitted/);
});
