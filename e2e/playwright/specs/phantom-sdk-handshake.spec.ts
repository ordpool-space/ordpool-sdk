import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { waitForApprovalPopup } from '../approval-popup';

/**
 * Iteration 3 of the Phantom E2E pipeline: SDK ↔ Phantom handshake.
 *
 * Phantom v26 returns BOTH a P2WPKH payment address and a P2TR
 * ordinals address from `btc_requestAccounts`. The SDK connector
 * splits them by `addressType`. Assert both derivations for the
 * abandon-seed.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/phantom');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');
const TEST_PASSWORD = 'TestPassword123!';

const EXPECTED_PAYMENT_ADDRESS  = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const EXPECTED_ORDINALS_ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `phantom-handshake-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardPhantom(page: Page): Promise<void> {
  if (page.url() === 'about:blank') {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'networkidle' });
  }

  // Match the actual button, not the help paragraph that contains
  // "import" + "wallet".
  // Raw CDP Input.dispatchMouseEvent — one layer below page.mouse,
  // which Phantom's onClick handler has ignored across every other
  // activation strategy.
  const importBtn = page.getByRole('button', { name: 'I Already Have a Wallet' });
  await expect(importBtn).toBeVisible({ timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  const box = await importBtn.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // Post-welcome: "Import a wallet" picker. Click "Import Recovery Phrase".
  const recoveryBtn = page.getByRole('button', { name: /Import Recovery Phrase/i });
  await expect(recoveryBtn).toBeVisible({ timeout: 20_000 });
  const recoveryBox = await recoveryBtn.boundingBox();
  if (recoveryBox) {
    const x = recoveryBox.x + recoveryBox.width / 2;
    const y = recoveryBox.y + recoveryBox.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  const mnemonicInputs = page.locator('input, textarea');
  await expect(mnemonicInputs.first()).toBeVisible({ timeout: 15_000 });
  const inputCount = await mnemonicInputs.count();
  if (inputCount >= 12) {
    for (let i = 0; i < TEST_MNEMONIC_WORDS.length; i++) {
      await mnemonicInputs.nth(i).fill(TEST_MNEMONIC_WORDS[i]);
    }
  } else {
    await mnemonicInputs.first().fill(TEST_MNEMONIC);
  }

  const confirmAfterMnemonic = page.getByRole('button', { name: /^import wallet$/i });
  await expect(confirmAfterMnemonic).toBeEnabled({ timeout: 15_000 });
  await confirmAfterMnemonic.click();

  // Wait for the result state (not the loading-spinner state) before
  // looking for Continue.
  const context = page.context();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      const text = await p.locator('body').innerText().catch(() => '');
      if (/We found .* accounts? with activity/i.test(text)) { page = p; break; }
    }
    if (/We found .* accounts? with activity/i.test(await page.locator('body').innerText().catch(() => ''))) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // Wait for Continue to be ENABLED (the disabled gray-pill state
  // transitions to the active state after Phantom finishes deriving
  // account info).
  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
    const candidate = els.find(el => (el.textContent || '').trim() === 'Continue');
    if (!candidate) return false;
    if (candidate.getAttribute('aria-disabled') === 'true') return false;
    if ((candidate as HTMLElement).hasAttribute('disabled')) return false;
    if (parseFloat(getComputedStyle(candidate).opacity) < 0.7) return false;
    return true;
  }, undefined, { timeout: 45_000, polling: 500 });
  const importAccountsContinue = page.getByText('Continue', { exact: true }).first();
  const newCdp = await page.context().newCDPSession(page);
  const b = await importAccountsContinue.boundingBox();
  if (b) {
    const x = b.x + b.width / 2; const y = b.y + b.height / 2;
    await newCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await newCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await newCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // Phantom opens YET ANOTHER page for "Create a password" after the
  // Import Accounts Continue (confirmed via CI 26713625161 trace).
  const ctx2 = page.context();
  const createPwDeadline = Date.now() + 60_000;
  let pwPage: Page | null = null;
  while (Date.now() < createPwDeadline) {
    for (const p of ctx2.pages()) {
      const text = await p.locator('body').innerText().catch(() => '');
      if (/Create a password/i.test(text)) { pwPage = p; break; }
    }
    if (pwPage) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (pwPage) {
    page = pwPage;
  }

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  await pwInputs.nth(0).fill(TEST_PASSWORD);
  await pwInputs.nth(1).fill(TEST_PASSWORD);

  // Reach UI custom-checkbox is visually hidden; fire native .click()
  // via JS so React's onChange toggles aria-checked.
  await page.locator('[data-testid="onboarding-form-terms-of-service-checkbox"]')
    .first().waitFor({ state: 'attached', timeout: 10_000 });
  await page.evaluate(() => {
    const cb = document.querySelector('[data-testid="onboarding-form-terms-of-service-checkbox"]') as HTMLInputElement | null;
    cb?.click();
  });
  await expect(
    page.locator('[data-testid="onboarding-form-terms-of-service-checkbox"][aria-checked="true"]'),
  ).toBeAttached({ timeout: 5_000 });

  // Wait for Continue enabled, CDP-click.
  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], div'));
    const candidate = els.find(el => (el.textContent || '').trim() === 'Continue');
    if (!candidate) return false;
    if (candidate.getAttribute('aria-disabled') === 'true') return false;
    if ((candidate as HTMLElement).hasAttribute('disabled')) return false;
    if (parseFloat(getComputedStyle(candidate).opacity) < 0.7) return false;
    return true;
  }, undefined, { timeout: 30_000, polling: 500 });
  const pwContinue = page.getByText('Continue', { exact: true }).first();
  const pwCdp = await page.context().newCDPSession(page);
  const pwBox = await pwContinue.boundingBox();
  if (pwBox) {
    const x = pwBox.x + pwBox.width / 2; const y = pwBox.y + pwBox.height / 2;
    await pwCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await pwCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await pwCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // Completion screen ("You're good to go!") or real dashboard.
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes("you're good to go")
      || t.includes('get started')
      || t.includes('send')
      || t.includes('receive')
      || t.includes('balance');
  }, undefined, { timeout: 60_000, polling: 500 });
  const gsLocator = page.getByText('Get Started', { exact: true }).first();
  if (await gsLocator.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page.bringToFront();
    const gsBox = await gsLocator.boundingBox();
    if (gsBox) {
      const cdp = await page.context().newCDPSession(page);
      const x = gsBox.x + gsBox.width / 2; const y = gsBox.y + gsBox.height / 2;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el) {
          const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, isPrimary: true } as PointerEventInit;
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        }
      }, { x, y });
    }
  }
  await page.waitForFunction(
    () => !/You're good to go/i.test(document.body.innerText || ''),
    undefined, { timeout: 10_000, polling: 300 },
  ).catch(() => undefined);
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Phantom extension not unpacked at ${EXT_PATH}.`);
  }
  if (!fs.existsSync(path.resolve(__dirname, '../fixtures/sdk-harness.js'))) {
    throw new Error('SDK harness bundle missing. Run `npm run e2e:harness:build`.');
  }

  // Write a minimal HTML file INTO the Phantom extension's unpacked
  // directory before Chrome loads it. This file gets the
  // chrome-extension://[id]/ origin (so chrome.runtime.* is exposed)
  // but contains zero Phantom JS — bypasses the popup-side sendMessage
  // wrapper. Iter 59 confirmed Chrome's "File not found" page does
  // NOT expose chrome.runtime, so a real file in the extension dir
  // is the bypass that works.
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
      // Treat the harness HTTP origin as secure. Iter 65 confirmed
      // Phantom injects .solana (chain-agnostic) but NEVER .bitcoin
      // on http://localhost:4500 — a 30s timeline poll showed
      // .bitcoin permanently absent. The most plausible remaining
      // gate is "BTC sub-provider requires secure context"; this
      // flag tells Chrome to treat the harness origin as secure
      // so a BTC-on-HTTPS-only check inside Phantom's content
      // script returns true.
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
  test.setTimeout(180_000);
  await onboardPhantom(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded').catch(() => undefined);
  // Phantom's "You're good to go!" gate refused every click strategy.
  // Source-dive of v26.14.0 serviceWorker.js byte 97870 found _unlockExtension:
  // it accepts { method:'unlockExtension', params: <password-string> }
  // via chrome.runtime.sendMessage and flips the wallet to unlocked.
  //
  // onboardPhantom navigates through several pages internally and the
  // outer `onboardPage` reference is stale (closed) by the time we get
  // here. Open a fresh popup.html and dispatch the unlock from there —
  // any chrome-extension:// page can call runtime.sendMessage on its
  // own SW.
  // Navigate to our injected extension-origin page that has zero
  // Phantom JS — chrome.runtime.sendMessage here is the raw Chrome
  // API, not Phantom's wrapper.
  const unlockPage = await context.newPage();
  await unlockPage.goto(
    `chrome-extension://${extensionId}/__ordpool_unlock__.html`,
    { waitUntil: 'domcontentloaded' },
  );
  // Diagnostic: log what chrome.runtime.sendMessage looks like here.
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

    // Iter 63 confirmed: enabledChainsOverrideSettings has
    // bitcoin:true and userPropsCache has bitcoinAddress —
    // Phantom KNOWS we want BTC. But window.phantom.bitcoin still
    // isn't injected on the harness. The content-script-side gate
    // is something else.
    //
    // New hypothesis: try dispatching the BTC-specific JSON-RPC
    // method to the SW directly. If the SW handles btc_requestAccounts,
    // we can build window.phantom.bitcoin ourselves from the test side.
    const btcProbe = await unlockPage.evaluate(async () => {
      try {
        const c = (globalThis as unknown as { chrome: { runtime: {
          sendMessage: (msg: unknown) => Promise<unknown>;
        } } }).chrome;
        const payload = JSON.stringify({ method: 'btc_requestAccounts', params: [], id: 2 });
        const r = await c.runtime.sendMessage(payload);
        return { ok: true, response: typeof r === 'string' ? r.slice(0, 400) : JSON.stringify(r).slice(0, 400) };
      } catch (e) {
        return { ok: false, err: String(e).slice(0, 400) };
      }
    });
    console.log(`[phantom:btc-probe] btc_requestAccounts → ${JSON.stringify(btcProbe)}`);

    // Register btc.js as a MAIN-world content script for the
    // harness origin. Phantom's SW never does this on its own
    // (the Cn function in serviceWorker.js only registers
    // evmAsk/evmPhantom/evmMetamask/sui — no BTC case), so the
    // BTC sub-provider that ships in the build remains dormant.
    // We do it ourselves from the unlock page, which is on the
    // extension origin and inherits Phantom's "scripting"
    // permission.
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

// REVERSE-ENGINEERING POST-MORTEM, Phantom v26.14.0
// (iters 47-73, manual disassembly of /tmp/phantom-ext/*.js):
//
// CONTEXT (researched 2026-06-05, see "Phantom Bitcoin support
// research report" in session transcript):
//   * Phantom remains committed to Bitcoin (Help Center, supported
//     networks list, blog/learn pages all current). No retreat
//     announced anywhere.
//   * BUT every page under docs.phantom.com/bitcoin/* now carries:
//       "The window.phantom.bitcoin provider will be deprecated
//        in an upcoming release."
//     They're mid-migration toward Wallet Standard (bip122: chain
//     IDs). The new @phantom/react-sdk lists its Bitcoin module as
//     "Coming Soon" — no replacement is shipped yet.
//   * Our v26.14.0 observation ("btc.js bundled but never injected,
//     SW has zero btc_* handlers") is undocumented in any public
//     source the researcher could find. Most plausible explanation
//     is a regression during the migration cutover, or an Eppo-
//     gated staged rollout we never landed on. Worth filing at
//     github.com/orgs/phantom/discussions — nobody else has
//     publicly reported this symptom.
//
// THE WALL: v26.14.0 SHIPS NO DAPP-SIDE BITCOIN SUPPORT AT ALL.
//
// Three layers needed for Phantom to serve a BTC dApp request:
//
//   (1) An in-page provider that exposes window.phantom.bitcoin
//       with requestAccounts() / signPSBT() / signMessage().
//   (2) A content script registered for dApp URLs that loads (1)
//       into the page's MAIN world.
//   (3) Service-worker handlers for the JSON-RPC method names (1)
//       proxies to (btc_requestAccounts / btc_signPSBT / etc).
//
// Phantom v26.14.0 ships (1) — btc.js, fully functional, see
// disassembly notes in phantom.signer.ts. It does NOT ship (2)
// or (3):
//
//   (2): manifest.json content_scripts loads only phantom.js +
//        solana.js + contentScript.js. The SW's conditional
//        content-script registrar Cn (byte 73937 of
//        serviceWorker.js) only handles Se.EVM and Se.Sui:
//
//        if (e.includes(Se.EVM)) switch (t) {
//          case "ALWAYS_ASK":   r.push("evmAsk.js"); break;
//          case "USE_PHANTOM":  r.push("evmPhantom.js"); break;
//          case "USE_METAMASK": r.push("evmMetamask.js"); break;
//        }
//        if (e.some(n => n === Se.Sui)) r.push("sui.js");
//
//        No Se.Bitcoin case. The Se enum only has EVM/Solana/Sui.
//        btc.js is in the build but no code path loads it. We can
//        register it ourselves with chrome.scripting.register-
//        ContentScripts from the unlock page (which inherits
//        Phantom's "scripting" permission) — proven in iter 72:
//        window.phantom.bitcoin appears after that.
//
//   (3): grep'd every .js file in the extension for btc_*,
//        bitcoin:*, signPSBT, requestBitcoinAccounts — ONLY
//        btc.js itself mentions them. serviceWorker.js + every
//        chunk: zero. The SW's RPC router (chunk-TRVAUBUF.js
//        byte 12704) returns `${method} isn't implemented` for
//        any method not in its handler map. Bitcoin methods are
//        never in the map. Iter 73 hit exactly this error:
//        `Me: btc_requestAccounts isn't implemented`.
//
// Phantom-as-wallet (UI, internal balances, address derivation,
// chrome.storage.local.userPropsCache.bitcoinAddress) works.
// Phantom-as-dApp-provider for Bitcoin does NOT work in v26.14.0.
// The integration is half-shipped — page side ready, SW side
// absent. Either rolled back from a previous version or staged
// for a future release that flipped some flag.
//
// What's still here:
//   * src/wallet/connectors/phantom.connector.ts +
//     src/wallet/signers/phantom.signer.ts match what
//     docs.phantom.com/bitcoin describes (direct
//     requestAccounts() + signPSBT(bytes, opts)). That's
//     literate code-as-documentation against a docs page that
//     itself carries a deprecation banner; we have NO
//     independent test pinning either side. When Phantom flips
//     a working surface back on, expect to rewrite the adapter
//     against whatever shape they actually ship, not what we
//     assumed today.
//   * Pipeline A signer mock spec for Phantom was deleted as
//     hallucinated-against-hallucinated coverage. The parser
//     unit test stays (pure function on a documented response
//     shape).
//
// Skip these e2e specs until Phantom completes (3). Re-enable
// by removing test.skip and confirming the SW responds to
// btc_requestAccounts (or whatever the successor method is).
// EMPIRICAL CONFIRMATION (iter 82, 2026-06-06): re-vendored
// Phantom v26.16.0 from current Chrome Web Store. Disassembly is
// byte-identical to v26.14.0 in the relevant paths (Bn renamed
// from Cn, same EVM/Sui-only registrar, same Se enum without
// Bitcoin, same zero btc_* SW handlers). CI runtime:
//   * iter-72 self-registration still works → hasBitcoin:true on
//     harness after reload
//   * SW response to btc_requestAccounts (via in-page provider OR
//     direct probe): "btc_requestAccounts isn't implemented"
//     ("not permitted" via the direct extension-origin probe)
// So this is NOT a stale-cache issue; Phantom currently ships
// the dApp BTC pipeline this way across at least v26.14.0 and
// v26.16.0. Likely Phantom stopped maintaining the legacy SW
// handlers ahead of the Wallet-Standard migration (per the
// docs.phantom.com/bitcoin/* deprecation banner) without
// shipping the new surface yet.
test.skip('phantomConnector.connect via the harness page returns the BIP-84 + BIP-86 mainnet addresses for the test seed', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  // Reload to force Phantom's content script to re-evaluate against
  // the now-unlocked SW.
  await harness.reload({ waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  // Iter 64 finding: btc_requestAccounts via SW returns "not
  // permitted" — the harness URL isn't an authorized dApp. The
  // sub-provider gating is permission-based. Poll for up to 30s
  // with a millisecond-precision arrival log so we can confirm
  // whether .bitcoin EVER appears or is permanently gated.
  const phantomTimeline = await harness.evaluate(async () => {
    const t0 = Date.now();
    const log: Array<{ at: number; hasPhantom: boolean; hasBitcoin: boolean; hasSolana: boolean }> = [];
    while (Date.now() - t0 < 30_000) {
      const w = window as unknown as { phantom?: { bitcoin?: unknown; solana?: unknown } };
      const p = w.phantom;
      const entry = { at: Date.now() - t0, hasPhantom: !!p, hasBitcoin: !!p?.bitcoin, hasSolana: !!p?.solana };
      const last = log[log.length - 1];
      if (!last || last.hasPhantom !== entry.hasPhantom || last.hasBitcoin !== entry.hasBitcoin || last.hasSolana !== entry.hasSolana) {
        log.push(entry);
        if (entry.hasBitcoin) break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return log;
  });
  console.log(`[phantom:sdk-handshake] phantomTimeline = ${JSON.stringify(phantomTimeline)}`);

  const knownPages = new Set(context.pages());
  const resultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectPhantom());
  resultPromise.catch(() => undefined);

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
  await shot(approval, '01-approval');
  await approval.getByRole('button', { name: /^(connect|approve|confirm|allow)$/i }).first().click();

  const info = await resultPromise;
  // eslint-disable-next-line no-console
  console.log(`[phantom:sdk-handshake] payment = ${info.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[phantom:sdk-handshake] ordinals = ${info.ordinalsAddress}`);

  expect(info.signingSupported).toBe(true);
  expect(info.paymentAddress).toBe(EXPECTED_PAYMENT_ADDRESS);
  expect(info.ordinalsAddress).toBe(EXPECTED_ORDINALS_ADDRESS);
  // Payment pubkey = compressed sec256k1 = 33 bytes = 66 hex.
  expect(info.paymentPublicKey).toMatch(/^[0-9a-f]{66}$/);
  // Ordinals pubkey is x-only (32 bytes = 64 hex) — Phantom returns
  // compressed but the SDK normalises to x-only for consistency.
  expect(info.ordinalsPublicKey).toMatch(/^[0-9a-f]{64}$/);
});
