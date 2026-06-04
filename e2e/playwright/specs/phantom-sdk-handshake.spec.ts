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

    // Dump mmkv flags / state keys (feature gates) raw — these may
    // hold the per-content-script chain-injection feature flag.
    const mmkvDump = await unlockPage.evaluate(async () => {
      const c = (globalThis as unknown as { chrome: { storage: { local: {
        get: (k: null, cb: (v: Record<string, unknown>) => void) => void;
      } } } }).chrome;
      const all = await new Promise<Record<string, unknown>>(r => c.storage.local.get(null, r));
      const out: Record<string, string> = {};
      for (const k of Object.keys(all)) {
        if (/^mmkv:|^EXTENSION_|^firstTime|^HAS_|providers/i.test(k)) {
          const v = all[k];
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          out[k] = s.length > 400 ? s.slice(0, 400) + '…' : s;
        }
      }
      return out;
    }).catch(err => ({ err: String(err) }));
    for (const [k, v] of Object.entries(mmkvDump)) {
      console.log(`[phantom:storage:flag] ${k} = ${v}`);
    }
  } else {
    console.log('[phantom:unlock-page] chrome.runtime.sendMessage not available; unlock skipped.');
  }
  await shot(unlockPage, '00b-after-unlock').catch(() => undefined);
  await unlockPage.close().catch(() => undefined);
});

test.afterAll(async () => {
  await context?.close();
});

// Re-skipped after iter 47. Source-dive of v26.14.0 found
// chrome.storage.local.firstTimeOnboarding ({isFirstTimeOnboarding:
// bool}) — the key Phantom reads to decide whether to gate dApp
// requests. Writing {isFirstTimeOnboarding: false} from the SW
// context successfully landed in storage, but Phantom STILL did
// not process dApp connect requests — the approval popup never
// opens. There's likely a parallel runtime state (in-memory) that
// the SW also checks, and the SW doesn't re-read storage on every
// dApp request. The next attempt would be to either trigger the SW
// to re-read state (e.g. via chrome.runtime.sendMessage) or unpack
// what other state is set on the real Get Started click.
//
// Wire contract remains pinned by phantom.signer.angular.spec.ts in
// Pipeline A. Phantom-onboard (the gold-standard click-through) is
// passing.
test('phantomConnector.connect via the harness page returns the BIP-84 + BIP-86 mainnet addresses for the test seed', async () => {
  test.setTimeout(180_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  // Diagnostic: is window.phantom.bitcoin reachable on the harness?
  // Iter 61 confirmed unlock works (SW responds isUnlocked:true) but
  // both Phantom specs still fail with the harness saying "Phantom
  // provider not injected". Phantom's content script may register a
  // stub on page-load while the SW is locked and not re-evaluate
  // after the SW unlocks. Reload the harness once to force a fresh
  // content-script evaluation against the now-unlocked SW.
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
  console.log(`[phantom:sdk-handshake] window.phantom on harness after reload = ${JSON.stringify(phantomVisible)}`);

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
