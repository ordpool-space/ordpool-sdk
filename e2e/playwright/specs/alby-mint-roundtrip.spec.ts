import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { waitForElectrsSync, waitForUtxoAt, rpc, mineBlocks, getTx, postTx, assertAllInputsSighashAll } from '../../regtest/regtest-helpers';

/**
 * Iteration 1 — full cat21 mint roundtrip with the real Alby
 * Browser Extension.
 *
 * Alby's wallet init is hostile to CI: every onboarding path goes
 * through the Lightning-connector picker (`src/app/screens/
 * connectors/Choose*`) and the cheapest options (ConnectAlby,
 * ConnectNWC, ConnectAlbyHub) require an OAuth login or a real
 * NWC backend.
 *
 * Bypass: pre-seed `chrome.storage.local` directly via Alby's own
 * background-script message bus. Reading the bundled router
 * (`background-script/router.ts`) tells us the actions we need:
 *
 *   setPassword  — required so addAccount/setMnemonic can encrypt
 *                  (state.getState().password() reads back this)
 *   addAccount   — stores an Account record (no validation per
 *                  background-script/actions/accounts/add.ts; the
 *                  validateAccount step that talks to the
 *                  connector backend is a separate UI-only call)
 *   setMnemonic  — encrypts the BIP-39 seed under the password
 *                  and attaches it to the account
 *
 * After that, `window.alby.getBitcoin()` resolves to a Bitcoin
 * instance backed by the seeded mnemonic. signPsbt works without
 * any Lightning backend.
 *
 * Account record uses `bitcoinNetwork: "regtest"` so the Taproot
 * derivation path is `m/86'/1'/0'/0/0` (per
 * background-script/bitcoin/index.ts) and the returned address
 * is bcrt1p... — no cross-network-keys trick needed.
 *
 * Alby's signPsbt is Taproot-only (`signTaprootInput` is the only
 * call); our cat21 mint PSBT therefore uses a Taproot input that
 * the seeded mnemonic can spend.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPassword123!';

// Alby v3.14.2's m/86'/1'/0'/0/0 derivation for the abandon×11+
// about seed (bitcoinNetwork: "regtest" → testnet coin-type). Value
// observed in iter 100 with the actual extension binary. Earlier
// iterations hard-coded the m/86'/0'/0'/0/0 (mainnet path) value
// by mistake — same x-only key visually familiar from BIP-86 test
// vectors but Alby honours its bitcoinNetwork: regtest setting.
const EXPECTED_REGTEST_TAPROOT = 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg';

const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;
// Long-lived extension-origin page kept open after the seed step so
// we can fire chrome.runtime.sendMessage at the SW's internal routes
// (webbtc/signPsbt) directly, bypassing Alby's prompt UI altogether.
// Iter 107 finding: the public/prompt path's React popup never
// returns from confirm(), but the internal direct route is the same
// code Alby's own popup calls — and works fine from any extension-
// origin page.
let seedPage: Page;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

/**
 * Seed Alby's account state by firing all three router messages
 * (setPassword → addAccount → setMnemonic) inside a single
 * page.evaluate. Iter 93 confirmed each call individually
 * succeeds, but Alby's React app on options.html navigates the
 * page reactively once `unlocked:true` lands, so between two
 * separate page.evaluate calls the page can close on us. Batching
 * keeps the page alive for one synchronous-from-Playwright's-view
 * sequence.
 *
 * Envelope shape per Alby's common/lib/msg.ts → msg.request.
 */
async function seedAlbyAccount(page: Page): Promise<string> {
  const result = await page.evaluate(async ({ password, mnemonic }) => {
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

    const setPwResp = await send('setPassword', { password });
    const addAccResp = await send('addAccount', {
      name: 'ordpool-e2e',
      connector: 'lndhub',
      config: { url: 'https://example.invalid', login: 'x', password: 'x' },
      bitcoinNetwork: 'regtest',
    }) as { data?: { accountId: string }; error?: string } | null;
    const accountId = addAccResp?.data?.accountId;
    const setMnemoResp = accountId
      ? await send('setMnemonic', { id: accountId, mnemonic })
      : null;
    return { setPwResp, addAccResp, accountId, setMnemoResp };
  }, { password: TEST_PASSWORD, mnemonic: TEST_MNEMONIC });

  // eslint-disable-next-line no-console
  console.log(`[alby-mint:seed] setPassword resp = ${JSON.stringify(result.setPwResp).slice(0, 200)}`);
  // eslint-disable-next-line no-console
  console.log(`[alby-mint:seed] addAccount resp = ${JSON.stringify(result.addAccResp).slice(0, 200)}`);
  // eslint-disable-next-line no-console
  console.log(`[alby-mint:seed] setMnemonic resp = ${JSON.stringify(result.setMnemoResp).slice(0, 200)}`);

  if (!result.accountId) {
    throw new Error(`Alby addAccount failed: ${JSON.stringify(result.addAccResp)}`);
  }
  return result.accountId;
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Alby extension not unpacked at ${EXT_PATH}. Run e2e/playwright/playwright-bootstrap.sh.`);
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

  seedPage = await context.newPage();
  // Iter 95 nailed the seed step by blocking window.close() before
  // Alby's React welcome wizard runs — options.html otherwise
  // self-closes on first paint and the seed evaluate dies. Scope
  // the override to seedPage only (page.addInitScript), NOT the
  // whole context, so Alby's permission/sign popups can still
  // close themselves after the user (or our auto-clicker) clicks
  // Connect — without that, the click in the popup hangs waiting
  // for window.close() to complete.
  await seedPage.addInitScript(() => {
    try {
      Object.defineProperty(window, 'close', { value: () => undefined, writable: false, configurable: false });
    } catch { /* ignore */ }
    try {
      const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
      window.addEventListener('beforeunload', stop as unknown as EventListener, true);
    } catch { /* ignore */ }
  });
  await seedPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  // Give the SW a moment to finish initializing its state machine.
  await seedPage.waitForFunction(() => true, undefined, { timeout: 2_000 }).catch(() => undefined);
  test.setTimeout(240_000);

  await seedAlbyAccount(seedPage);

  await shot(seedPage, '00-after-seed').catch(() => undefined);
  // KEEP seedPage open — the mint test uses it to talk to the SW
  // directly for signing. Closing it is done in afterAll.
});

test.afterAll(async () => {
  await context?.close();
});

test('mint a cat21 on regtest via Alby: seed mnemonic via SW messages, sign Taproot PSBT, broadcast via local electrs', async () => {
  test.setTimeout(300_000);

  // alby.enable() opens a permission popup that a real user clicks.
  // In CI, install a page listener that auto-confirms any newly
  // opened Alby UI page by clicking the first Connect / Allow /
  // Confirm button it finds. The same listener also covers the
  // signPsbt confirmation that follows.
  let popupCount = 0;
  context.on('page', async (popup) => {
    const idx = ++popupCount;
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      if (!popup.url().startsWith('chrome-extension://')) return;
      await shot(popup, `popup-${idx}-loaded`).catch(() => undefined);
      // Iter 97 screenshots showed a transient error toast ("API
      // error https://example.invalid") covering the Connect button.
      // Source: our dummy lndhub config triggers an auto-validate
      // balance fetch that fails — harmless but the toast occludes
      // clicks for ~5s. Wait it out, then enumerate buttons so we
      // can pick the actual Connect by aria/text rather than first-
      // matching anything.
      await popup.waitForTimeout(6_000);
      const buttons = await popup.locator('button').all();
      const labels: string[] = [];
      for (const b of buttons) {
        const text = (await b.textContent().catch(() => '') ?? '').trim();
        const aria = (await b.getAttribute('aria-label').catch(() => null)) ?? '';
        labels.push(`"${text}"${aria ? `[aria=${aria}]` : ''}`);
      }
      // eslint-disable-next-line no-console
      console.log(`[alby-mint] popup #${idx} buttons: ${labels.join(' | ')}`);
      const connect = popup.locator('button', { hasText: /^(connect|allow|confirm|approve|sign)$/i }).first();
      await connect.waitFor({ state: 'visible', timeout: 5_000 });
      await connect.click({ timeout: 5_000 });
      // eslint-disable-next-line no-console
      console.log(`[alby-mint] clicked Connect on popup #${idx}: ${popup.url().slice(0, 80)}`);
      await shot(popup, `popup-${idx}-after-click`).catch(() => undefined);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[alby-mint] popup #${idx} auto-click skipped: ${String(e).slice(0, 200)}`);
      await shot(popup, `popup-${idx}-failed`).catch(() => undefined);
    }
  });

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // Iter 99 enumeration confirmed: alby exposes webln/nostr/webbtc/
  // liquid as sub-namespaces. The Bitcoin one is `webbtc` (not
  // `bitcoin`). Methods live on the prototype so Object.keys returns
  // only the closure state — walk the prototype chain too.
  const apiSurface = await harness.evaluate(() => {
    const allMethods = (o: object): string[] => {
      const out: string[] = [];
      let cur: object | null = o;
      while (cur && cur !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(cur)) {
          if (typeof (o as Record<string, unknown>)[k] === 'function' && !out.includes(k)) out.push(k);
        }
        cur = Object.getPrototypeOf(cur);
      }
      return out;
    };
    const w = window as unknown as Record<string, unknown>;
    const alby = w.alby as Record<string, unknown> | undefined;
    return {
      alby: alby ? Object.keys(alby) : null,
      albyMethods: alby ? allMethods(alby) : null,
      webbtcMethods: alby?.webbtc ? allMethods(alby.webbtc as object) : null,
      weblnMethods: alby?.webln ? allMethods(alby.webln as object) : null,
    };
  });
  console.log(`[alby-mint] API surface = ${JSON.stringify(apiSurface)}`);

  // Call window.alby.enable() to grant the dApp permission, then
  // call alby.webbtc.getAddress() (the WebBTC namespace, v3.14.2).
  const connectInfo = await harness.evaluate(async () => {
    interface WebBtcApi {
      enable?(): Promise<void>;
      getAddress(): Promise<{ address: string; publicKey: string } | string>;
    }
    interface AlbyApi {
      enable(): Promise<void>;
      webbtc: WebBtcApi;
    }
    const alby = (window as unknown as { alby: AlbyApi }).alby;
    await alby.enable();
    if (alby.webbtc.enable) await alby.webbtc.enable();
    const res = await alby.webbtc.getAddress();
    return typeof res === 'string'
      ? { address: res, publicKey: '' }
      : { address: res.address ?? '', publicKey: res.publicKey ?? '' };
  });
  console.log(`[alby-mint] address = ${connectInfo.address}`);
  console.log(`[alby-mint] publicKey = ${connectInfo.publicKey}`);
  expect(connectInfo.address).toBe(EXPECTED_REGTEST_TAPROOT);

  // Fund the Taproot address with regtest BTC.
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', connectInfo.address, String(FUND_AMOUNT_BTC)).trim();
  console.log(`[alby-mint] funded ${connectInfo.address} with ${FUND_AMOUNT_BTC} BTC in tx ${fundTxid}`);
  const newTip = mineBlocks(1);
  await waitForElectrsSync(newTip);

  const utxo = await waitForUtxoAt(connectInfo.address, Math.round(FUND_AMOUNT_BTC * 1e8));
  console.log(`[alby-mint] using UTXO ${utxo.txid}:${utxo.vout} value=${utxo.value}`);

  // Build a Taproot-input cat21 mint PSBT in the harness. The
  // harness already has @scure/btc-signer wired up; we drive the
  // same createTransaction path Unisat/Wizz/OKX use, but with a
  // Taproot input shape (cat21 mint has nLockTime=21, single
  // input, single output that mirrors the input minus fee).
  const psbtBuildResult = await harness.evaluate((args) => {
    return window.ordpoolSdkHarness.buildCat21TaprootPsbt(args);
  }, {
    utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
    taprootAddress: connectInfo.address,
    taprootPublicKey: connectInfo.publicKey,
    feeSats: 1500,
  }).catch((e) => ({ error: String(e) } as { psbtHex?: string; error?: string }));
  if ('error' in psbtBuildResult && psbtBuildResult.error) {
    throw new Error(`harness PSBT build failed (probably needs buildCat21TaprootPsbt added): ${psbtBuildResult.error}`);
  }
  const psbtHex = (psbtBuildResult as { psbtHex: string }).psbtHex;
  console.log(`[alby-mint] PSBT hex length = ${psbtHex.length}`);

  // Sign the PSBT via Alby. Reading
  // background-script/bitcoin/index.ts signPsbt(): it parses the
  // PSBT, signs every input with the Taproot key derived from the
  // mnemonic, FINALIZES, and returns extractTransaction().toHex()
  // — i.e. wire-format raw tx hex, NOT signed-PSBT hex. The
  // {signed: <string>} response from the WebBTC layer wraps that
  // wire-tx hex.
  // Iter 107 breakthrough: bypass Alby's prompt UI entirely.
  //
  // The public alby.webbtc.signPsbt() routes through:
  //   inpage → content-script → SW (public/webbtc/signPsbtWithPrompt)
  //   → openPrompt → React ConfirmSignPsbt → confirm()
  //   → api.bitcoin.signPsbt() → SW (webbtc/signPsbt)
  //
  // The popup's confirm() never returns from its await (iter 105's
  // 5+ iterations of debugging confirmed). But the LAST link in
  // that chain — webbtc/signPsbt — is the same internal route
  // Alby's own popup calls. It runs bitcoinjs-lib synchronously
  // and returns {data: {signed}}.
  //
  // seedPage is still on options.html (extension-origin), so it
  // can fire chrome.runtime.sendMessage directly to that internal
  // route. No React popup, no msg.reply round-trip, no openPrompt
  // listener race. Same code path Alby's own popup would take if
  // it could complete its post-sign UI step.
  const signResult = await seedPage.evaluate(async (psbtHex) => {
    const c = (globalThis as unknown as { chrome: { runtime: {
      sendMessage: (msg: unknown) => Promise<unknown>;
    } } }).chrome;
    return await c.runtime.sendMessage({
      application: 'LBE',
      prompt: true,
      action: 'webbtc/signPsbt',
      args: { psbt: psbtHex },
      origin: { internal: true },
    }) as { data?: { signed: string }; error?: string };
  }, psbtHex);
  console.log(`[alby-mint] signPsbt response = ${JSON.stringify(signResult).slice(0, 400)}`);

  if (signResult.error || !signResult.data?.signed) {
    throw new Error(`Alby webbtc/signPsbt failed: ${JSON.stringify(signResult)}`);
  }
  // Per Alby's bitcoin/index.ts signPsbt(): signs every input,
  // finalizes, returns extractTransaction().toHex() — i.e. wire-
  // format raw tx hex, not signed-PSBT hex.
  const signed = signResult.data.signed;
  const broadcastTxid = await postTx(signed);
  console.log(`[alby-mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await getTx(broadcastTxid);
  console.log(`[alby-mint] locktime=${esploraTx.locktime}`);
  expect(esploraTx.locktime).toBe(21);
  assertAllInputsSighashAll(esploraTx);

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
