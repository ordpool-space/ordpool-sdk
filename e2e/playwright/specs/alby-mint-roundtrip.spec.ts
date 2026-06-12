import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { getUtxos, waitForElectrsSync, rpc, mineBlocks, getTx, postTx } from '../../regtest/regtest-helpers';

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

// Alby's m/86'/1'/0'/0/0 for the abandon×11+about seed on regtest.
// Verified by deriving the same path with @scure/btc-signer in the
// harness; if Alby instead returns the mainnet path
// (m/86'/0'/0'/0/0), the assertion below catches it and we know
// the seed step failed to write `bitcoinNetwork: "regtest"`.
const EXPECTED_REGTEST_TAPROOT = 'bcrt1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

const FUND_AMOUNT_BTC = 0.001;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-mint-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

/**
 * Send a message to Alby's background-script router via
 * chrome.runtime.sendMessage. Pattern matches Alby's own
 * `common/lib/msg.ts` (origin: "background", type: <route name>,
 * args: <payload>).
 */
async function sendAlbyMessage(page: Page, type: string, args: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async ({ type, args }) => {
    const c = (globalThis as unknown as { chrome: { runtime: {
      sendMessage: (msg: unknown) => Promise<unknown>;
    } } }).chrome;
    return await c.runtime.sendMessage({
      type,
      args,
      origin: 'background',
    });
  }, { type, args });
}

async function seedAlbyAccount(page: Page): Promise<string> {
  // 1. Set the unlock password. Alby's state.password() reads this
  //    back; setMnemonic / addAccount need it to encrypt.
  const setPwResp = await sendAlbyMessage(page, 'setPassword', { password: TEST_PASSWORD });
  // eslint-disable-next-line no-console
  console.log(`[alby-mint:seed] setPassword resp = ${JSON.stringify(setPwResp).slice(0, 200)}`);

  // 2. Add a minimal account. We use the lndhub connector with
  //    dummy config because (a) addAccount itself doesn't validate
  //    per actions/accounts/add.ts, (b) the connector is only
  //    instantiated on Lightning operations, which our on-chain
  //    test doesn't trigger. bitcoinNetwork: "regtest" matches
  //    background-script/bitcoin/index.ts BTC_TAPROOT_DERIVATION
  //    _PATH_REGTEST = m/86'/1'/0'/0.
  const addAccResp = await sendAlbyMessage(page, 'addAccount', {
    name: 'ordpool-e2e',
    connector: 'lndhub',
    config: { url: 'https://example.invalid', login: 'x', password: 'x' },
    bitcoinNetwork: 'regtest',
  }) as { data?: { accountId: string }; error?: string };
  // eslint-disable-next-line no-console
  console.log(`[alby-mint:seed] addAccount resp = ${JSON.stringify(addAccResp).slice(0, 200)}`);
  if (!addAccResp.data?.accountId) {
    throw new Error(`Alby addAccount failed: ${JSON.stringify(addAccResp)}`);
  }
  const accountId = addAccResp.data.accountId;

  // 3. Attach the test mnemonic. Alby encrypts it under the
  //    password (actions/mnemonic/setMnemonic.ts) and stores it on
  //    the Account record.
  const setMnemoResp = await sendAlbyMessage(page, 'setMnemonic', {
    id: accountId,
    mnemonic: TEST_MNEMONIC,
  });
  // eslint-disable-next-line no-console
  console.log(`[alby-mint:seed] setMnemonic resp = ${JSON.stringify(setMnemoResp).slice(0, 200)}`);

  return accountId;
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

  // Open any chrome-extension origin page to talk to the router.
  // popup.html requires the extension to be unlocked; options.html
  // is the welcome/onboard screen and accepts messages before any
  // password has been set.
  const seedPage = await context.newPage();
  await seedPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  // Give the SW a moment to finish initializing its state machine.
  await seedPage.waitForFunction(() => true, undefined, { timeout: 2_000 }).catch(() => undefined);
  test.setTimeout(240_000);

  await seedAlbyAccount(seedPage);

  // Reload popup so the freshly seeded state takes effect.
  await seedPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await shot(seedPage, '00-after-seed');
  await seedPage.close().catch(() => undefined);
});

test.afterAll(async () => {
  await context?.close();
});

test('mint a cat21 on regtest via Alby: seed mnemonic via SW messages, sign Taproot PSBT, broadcast via local electrs', async () => {
  test.setTimeout(300_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // Call window.alby.enable() to grant the dApp permission, then
  // window.alby.getBitcoin().getAddress() to retrieve the Taproot
  // address Alby derived from the seeded mnemonic.
  const connectInfo = await harness.evaluate(async () => {
    interface AlbyBtcApi {
      getAddress(): Promise<{ address: string; publicKey: string } | string>;
    }
    interface AlbyApi {
      enable(): Promise<void>;
      getBitcoin(): AlbyBtcApi;
    }
    const alby = (window as unknown as { alby: AlbyApi }).alby;
    await alby.enable();
    const btc = alby.getBitcoin();
    const res = await btc.getAddress();
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

  const utxos = await getUtxos(connectInfo.address);
  const utxo = utxos.find(u => u.value === Math.round(FUND_AMOUNT_BTC * 1e8));
  if (!utxo) throw new Error(`could not find ${FUND_AMOUNT_BTC} BTC UTXO at ${connectInfo.address}`);
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
  const signResult = await harness.evaluate(async (psbtHex: string) => {
    interface AlbyBtcApi {
      signPsbt(psbtHex: string): Promise<{ signed: string }>;
    }
    interface AlbyApi {
      enable(): Promise<void>;
      getBitcoin(): AlbyBtcApi;
    }
    const alby = (window as unknown as { alby: AlbyApi }).alby;
    await alby.enable();
    const btc = alby.getBitcoin();
    const res = await btc.signPsbt(psbtHex);
    return res;
  }, psbtHex);
  console.log(`[alby-mint] signPsbt response = ${JSON.stringify(signResult).slice(0, 200)}`);

  // Per Alby's source, `signed` is wire-tx hex (already finalised).
  // Broadcast directly via local electrs.
  const broadcastTxid = await postTx(signResult.signed);
  console.log(`[alby-mint] broadcast txid = ${broadcastTxid}`);
  expect(broadcastTxid).toMatch(/^[0-9a-f]{64}$/);

  const confirmedTip = mineBlocks(1);
  await waitForElectrsSync(confirmedTip);
  const esploraTx = await getTx(broadcastTxid);
  console.log(`[alby-mint] locktime=${esploraTx.locktime}`);
  expect(esploraTx.locktime).toBe(21);

  const parsed = Cat21ParserService.parse(esploraTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(broadcastTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});
