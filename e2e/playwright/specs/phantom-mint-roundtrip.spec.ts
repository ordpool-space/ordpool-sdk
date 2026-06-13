import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { onboardPhantom } from '../onboard-phantom';

/**
 * Iteration 5 — full cat21 mint roundtrip with the real Phantom
 * extension. Phantom is multi-chain; the BTC sub-provider speaks
 * JSON-RPC via `phantom.bitcoin.request({method:"btc_signPSBT",
 * params:[bytes, {inputsToSign, finalize:false}]})`.
 *
 * Dual-address contract: payment = BIP-84 P2WPKH, ordinals =
 * BIP-86 P2TR. Cross-network-keys trick applies as with Unisat —
 * Phantom only ships mainnet, so we sign a regtest-encoded PSBT
 * against the mainnet wallet (the P2WPKH script hash matches).
 *
 * Phantom's onboarding leaves the wallet on "You're good to go!"
 * which can't be advanced via automation. We navigate the onboard
 * tab to popup.html to leave that screen and land on the dashboard,
 * which IS the state where dApp connect requests trigger approval
 * popups.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/phantom');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `phantom-mint-${name}.png`),
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

  // Write a minimal HTML file into the Phantom extension dir for
  // the unlock bypass. See phantom-sdk-handshake for full rationale.
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
      // See phantom-sdk-handshake for rationale: treat the harness
      // HTTP origin as secure so a possible BTC-on-HTTPS-only gate
      // inside Phantom's content script returns true.
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
  // Unlock the wallet via runtime.sendMessage({method:'unlockExtension'})
  // — source-dive of v26.14.0 serviceWorker.js byte 97870 confirmed
  // this is the SW handler that flips the wallet to unlocked. Bypasses
  // the unclickable "Get Started" UI gate.
  //
  // onboardPhantom navigates through several pages internally and the
  // outer `onboardPage` reference is stale (closed) by the time we get
  // here. Open a fresh popup.html for the unlock call.
  // Navigate to our injected extension-origin page that has zero
  // Phantom JS — chrome.runtime.sendMessage here is the raw Chrome
  // API, not Phantom's wrapper.
  const unlockPage = await context.newPage();
  await unlockPage.goto(
    `chrome-extension://${extensionId}/__ordpool_unlock__.html`,
    { waitUntil: 'domcontentloaded' },
  );
  const smInfo = await unlockPage.evaluate(() => {
    const c = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome;
    const sm = c?.runtime?.sendMessage;
    return { available: typeof sm === 'function', src: typeof sm === 'function' ? (sm as () => unknown).toString().slice(0, 200) : null };
  }).catch(err => ({ available: false, src: null, err: String(err) }));
  console.log(`[phantom:unlock-page] sendMessage info = ${JSON.stringify(smInfo).slice(0, 300)}`);
  if (smInfo.available) {
    const unlockOutcome = await unlockPage.evaluate(async (pwd: string) => {
      try {
        const c = (globalThis as unknown as { chrome: { runtime: {
          sendMessage: (msg: unknown) => Promise<unknown>;
        } } }).chrome;
        const payload = JSON.stringify({ method: 'unlockExtension', params: pwd, id: 1 });
        const r = await c.runtime.sendMessage(payload);
        return { ok: true, response: JSON.stringify(r).slice(0, 200) };
      } catch (e) {
        return { ok: false, err: String(e).slice(0, 300) };
      }
    }, 'TestPassword123!');
    console.log(`[phantom:unlock-page] unlock outcome = ${JSON.stringify(unlockOutcome)}`);

    // Register btc.js as a content script for the harness origin.
    // Phantom's SW never does this on its own. See phantom-sdk-
    // handshake for the reverse-engineering rationale.
    const registerOutcome = await unlockPage.evaluate(async () => {
      try {
        const c = (globalThis as unknown as { chrome: { scripting: {
          registerContentScripts: (scripts: unknown[]) => Promise<void>;
          unregisterContentScripts: (opts: { ids: string[] }) => Promise<void>;
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
        return { ok: true };
      } catch (e) {
        return { ok: false, err: String(e).slice(0, 300) };
      }
    });
    console.log(`[phantom:btc-inject-register] ${JSON.stringify(registerOutcome)}`);
  } else {
    console.log('[phantom:unlock-page] chrome.runtime.sendMessage not available; unlock skipped.');
  }
  await shot(unlockPage, '00b-after-unlock').catch(() => undefined);
  await unlockPage.close().catch(() => undefined);
});

test.afterAll(async () => {
  await context?.close();
});

// See phantom-sdk-handshake for the full reverse-engineering
// post-mortem (iters 47-73). Phantom v26.14.0 ships btc.js (the
// in-page provider) but NOT (a) the content-script registration
// that would load it, NOR (b) the SW handlers it would call.
// We fixed (a) ourselves via chrome.scripting.registerContent
// Scripts from the unlock page — window.phantom.bitcoin appears
// on the harness — but (b) the SW returns "btc_requestAccounts
// isn't implemented" because no such handler exists in v26.14.0's
// service worker. dApp-side Bitcoin support is structurally
// absent in this Phantom build; can't be driven from the test
// side without modifying the SW. Re-enable when Phantom ships a
// version with the SW handlers wired up.
// Iter 82 confirmed empirically against v26.16.0 (current Chrome
// Web Store version): the SW still throws
// `Me: btc_requestAccounts isn't implemented`. See
// phantom-sdk-handshake.spec.ts for the full empirical writeup.
// Pin Phantom's current desktop-build reality: the mint roundtrip
// can't even start because phantomConnector.connect rejects (SW
// has no btc_* handlers). See phantom-sdk-handshake for the full
// reverse-engineering writeup. This test runs instead of being
// skipped — it asserts the connect rejection so we get a positive
// signal that pins the wallet's current state. If Phantom enables
// the SW handlers, this test flips red and we know to rewrite
// the spec as a full mint roundtrip.
test('phantom v26.16: mint roundtrip blocked at connect step (SW lacks btc_* handlers)', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  // Reload to force Phantom's content script to re-evaluate against
  // the now-unlocked SW. See phantom-sdk-handshake for rationale.
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
  console.log(`[phantom-mint] window.phantom on harness after reload = ${JSON.stringify(phantomVisible)}`);
  await shot(harness, '01-harness-loaded');

  // The self-registration of btc.js (in beforeAll) means window
  // .phantom.bitcoin DID appear and detection succeeds.
  expect(phantomVisible.hasPhantom).toBe(true);
  expect(phantomVisible.hasBitcoin).toBe(true);

  // But connect rejects — SW has no btc_requestAccounts handler.
  const connectOutcome = await harness.evaluate(async () => {
    try {
      const info = await window.ordpoolSdkHarness.connectPhantom();
      return { ok: true, info };
    } catch (e) {
      return { ok: false, err: String((e as Error).message || e) };
    }
  });
  console.log(`[phantom-mint] connectPhantom outcome = ${JSON.stringify(connectOutcome).slice(0, 300)}`);
  expect(connectOutcome.ok).toBe(false);
  expect(connectOutcome.err).toMatch(/btc_requestAccounts isn't implemented|not permitted/);
});

// Reference addresses for the day Phantom ships BTC support and
// we rewrite this spec as a full mint roundtrip. Source: BIP-84
// m/84'/0'/0'/0/0 + BIP-86 m/86'/0'/0'/0/0 for the abandon×11+
// about test seed.
//   payment  (P2WPKH): bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
//   ordinals (P2TR):   bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr
