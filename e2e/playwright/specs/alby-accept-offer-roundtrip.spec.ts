import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { Network, toScureNetwork } from '../../../src/network';
import { buildCat21BuyOfferPsbt, validateCat21BuyOfferPsbt } from '../../../src/cat21-offer/cat21-offer.helper';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';

import {
  waitForElectrsSync,
  waitForUtxoAt,
  waitForUtxoMatching,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
  assertAllInputsSighashAll,
} from '../../regtest/regtest-helpers';

/**
 * Full CAT-21 ACCEPT-OFFER roundtrip with the real Alby Browser
 * Extension — Alby is the SELLER.
 *
 * Same SW-message bypass as `alby-mint-roundtrip.spec.ts`: seed Alby
 * via the LBE background-script router, then drive `webbtc/signPsbt`
 * directly from an extension-origin page.
 *
 * Flow:
 *   1. Seed + connect Alby (single Taproot bcrt1p address).
 *   2. Fund Alby, mint a cat via Alby. Cat lands on Alby's bcrt1p UTXO.
 *   3. Synthesise + fund a raw-key BUYER (P2WPKH bcrt1q).
 *   4. Buyer builds the buy-offer PSBT via the real SDK builder
 *      (input 0 = Alby's cat, input 1 = buyer funding) and signs
 *      input 1. Input 0 stays unsigned.
 *   5. Inject Alby's x-only key as `tapInternalKey` on input 0 — the
 *      seller-wallet key-prep step (the buyer ships only the cat's
 *      witnessUtxo; the seller adds its own internal key before
 *      signing). Then Alby signs input 0 via the SW bypass.
 *   6. Broadcast the finalized wire tx. Assert via electrs + parser
 *      (NEVER ord): the 546-sat output-0 UTXO lands at the buyer's
 *      address, lockTime=21, SIGHASH_ALL on every input, tx parses
 *      as CAT-21.
 *
 * The Alby CI shard runs bitcoind + electrs ONLY (no cat21-ord), so
 * ownership is proven by electrs' UTXO set.
 *
 * Accept-offer is the offer half where Alby is the LAST signer, so its
 * finalize-and-return-wire-tx behaviour is compatible in principle. The
 * open question this spec answers empirically: Alby's `signPsbt` signs
 * EVERY input with its single Taproot key (verified against
 * background.bundle.js; see `src/wallet/signers/alby.signer.ts`), so it
 * would also try to Taproot-sign the buyer's already-signed P2WPKH
 * input 1. Whether Alby signs only input 0 and honours the buyer's
 * input-1 signature on finalize, or chokes on input 1, is what CI
 * reveals. Do NOT assume it works.
 *
 * Build note: no build-only Alby harness entry exists for acceptOffer
 * (harness ships mint/inscribe only; its generic `runOperation` throws
 * for Alby). The offer PSBT is built directly here via the real SDK
 * `buildCat21BuyOfferPsbt` — same pure builder, identical bytes.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPassword123!';
const EXPECTED_REGTEST_TAPROOT = 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg';

const FUND_AMOUNT_BTC = 0.001;
const BUYER_FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const OFFER_FEE_SATS = 1500;
const PRICE_SATS = 50_000;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;
let seedPage: Page;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-accept-offer-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

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

  if (!result.accountId) {
    throw new Error(`Alby addAccount failed: ${JSON.stringify(result.addAccResp)}`);
  }
  return result.accountId;
}

/**
 * Sign a PSBT (hex) via Alby's internal `webbtc/signPsbt` route from
 * the extension-origin seedPage. Alby signs every input with its
 * Taproot key, FINALIZES, and returns wire-format raw tx hex in
 * `data.signed`. Throws on any Alby-side error.
 */
async function signPsbtViaAlby(page: Page, psbtHex: string): Promise<string> {
  const signResult = await page.evaluate(async (psbt) => {
    const c = (globalThis as unknown as { chrome: { runtime: {
      sendMessage: (msg: unknown) => Promise<unknown>;
    } } }).chrome;
    return await c.runtime.sendMessage({
      application: 'LBE',
      prompt: true,
      action: 'webbtc/signPsbt',
      args: { psbt },
      origin: { internal: true },
    }) as { data?: { signed: string }; error?: string };
  }, psbtHex);
  // eslint-disable-next-line no-console
  console.log(`[alby-accept-offer] signPsbt response = ${JSON.stringify(signResult).slice(0, 400)}`);
  if (signResult.error || !signResult.data?.signed) {
    throw new Error(`Alby webbtc/signPsbt failed: ${JSON.stringify(signResult)}`);
  }
  return signResult.data.signed;
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
  await seedPage.waitForFunction(() => true, undefined, { timeout: 2_000 }).catch(() => undefined);
  test.setTimeout(240_000);

  await seedAlbyAccount(seedPage);
  await shot(seedPage, '00-after-seed').catch(() => undefined);
});

test.afterAll(async () => {
  await context?.close();
});

test('accept a CAT-21 buy offer on regtest via Alby (seller): mint, buyer builds + signs input 1, Alby signs input 0', async () => {
  test.setTimeout(300_000);
  const regtestNetwork = toScureNetwork(Network.Regtest);

  // Auto-confirm the alby.enable() permission popup during connect.
  context.on('page', async (popup) => {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      if (!popup.url().startsWith('chrome-extension://')) return;
      await popup.waitForTimeout(6_000);
      const connect = popup.locator('button', { hasText: /^(connect|allow|confirm|approve|sign)$/i }).first();
      await connect.waitFor({ state: 'visible', timeout: 5_000 });
      await connect.click({ timeout: 5_000 });
    } catch { /* swallow */ }
  });

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // ── Connect Alby (the seller) ──
  const connectInfo = await harness.evaluate(async () => {
    interface WebBtcApi {
      enable?(): Promise<void>;
      getAddress(): Promise<{ address: string; publicKey: string } | string>;
    }
    interface AlbyApi { enable(): Promise<void>; webbtc: WebBtcApi; }
    const alby = (window as unknown as { alby: AlbyApi }).alby;
    await alby.enable();
    if (alby.webbtc.enable) await alby.webbtc.enable();
    const res = await alby.webbtc.getAddress();
    return typeof res === 'string'
      ? { address: res, publicKey: '' }
      : { address: res.address ?? '', publicKey: res.publicKey ?? '' };
  });
  // eslint-disable-next-line no-console
  console.log(`[alby-accept-offer] seller(alby) address=${connectInfo.address} publicKey=${connectInfo.publicKey}`);
  expect(connectInfo.address).toBe(EXPECTED_REGTEST_TAPROOT);
  const albyAddress = connectInfo.address;
  const albyPubBytes = hexBytes(connectInfo.publicKey);
  const albyXOnly = albyPubBytes.length === 32 ? albyPubBytes : albyPubBytes.slice(1, 33);
  const albyTaprootScript = btc.p2tr(albyXOnly, undefined, regtestNetwork).script;

  // ── Fund Alby, mint a self-cat via Alby ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', albyAddress, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(albyAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  const mintBuild = await harness.evaluate((args) => {
    return window.ordpoolSdkHarness.buildCat21MintPsbtForAlby(args);
  }, {
    utxo: { txid: fundUtxo.txid, vout: fundUtxo.vout, value: fundUtxo.value },
    paymentAddress: albyAddress,
    paymentPublicKey: connectInfo.publicKey,
    recipientAddress: albyAddress,
    feeSats: MINT_FEE_SATS,
  }).catch((e) => ({ error: String(e) } as { psbtHex?: string; error?: string }));
  if ('error' in mintBuild && mintBuild.error) {
    throw new Error(`harness mint PSBT build failed: ${mintBuild.error}`);
  }
  const mintWireHex = await signPsbtViaAlby(seedPage, (mintBuild as { psbtHex: string }).psbtHex);
  const mintTxid = await postTx(mintWireHex);
  // eslint-disable-next-line no-console
  console.log(`[alby-accept-offer] mint broadcast txid = ${mintTxid}`);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  const sellerCatUtxo = await waitForUtxoMatching(
    albyAddress,
    u => u.txid === mintTxid && u.vout === 0,
    `seller(alby) cat ${mintTxid}:0`,
  );
  expect(sellerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);

  // ── Synthesise BUYER (raw P2WPKH), fund ──
  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyerPub = secp256k1.getPublicKey(buyerPriv, true);
  const buyerP2 = btc.p2wpkh(buyerPub, regtestNetwork);
  const buyerAddress = buyerP2.address!;
  const buyerScript = buyerP2.script;
  // eslint-disable-next-line no-console
  console.log(`[alby-accept-offer] buyer address = ${buyerAddress}`);

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', buyerAddress, String(BUYER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const buyerFundUtxo = await waitForUtxoAt(buyerAddress, Math.round(BUYER_FUND_AMOUNT_BTC * 1e8));

  // ── Buyer builds the offer PSBT (input 0 = Alby's cat) via SDK ──
  const offer = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.cat21wallet,
    network: Network.Regtest,
    sellerInput: {
      txid: mintTxid,
      vout: 0,
      value: CAT21_POSTAGE_SATS,
      scriptPubKey: albyTaprootScript,
    },
    buyerInputs: [{
      txid: buyerFundUtxo.txid,
      vout: buyerFundUtxo.vout,
      value: buyerFundUtxo.value,
      scriptPubKey: buyerScript,
    }],
    destinations: {
      buyerReceiveAddress: buyerAddress,
      sellerPaymentAddress: albyAddress,
      buyerChangeAddress: buyerAddress,
    },
    priceSats: PRICE_SATS,
    feeSats: OFFER_FEE_SATS,
  });

  // ── Buyer signs input 1 (their funding) under SIGHASH_ALL ──
  const offerTx = btc.Transaction.fromPSBT(offer.psbt);
  offerTx.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);
  const buyerSignedPsbtBytes = offerTx.toPSBT();

  // Sanity: seller-side validator accepts the buyer-pre-signed PSBT.
  const validation = validateCat21BuyOfferPsbt({
    psbt: buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: albyAddress,
    network: Network.Regtest,
  });
  expect(validation.ok).toBe(true);

  // ── Seller-wallet key-prep: inject Alby's x-only internal key on
  //    input 0 so Alby's key-path Taproot signer can sign the cat. The
  //    buyer ships only the cat's witnessUtxo; the seller adds its own
  //    internal key. tapInternalKey is a PSBT-level field, so the
  //    unsigned-tx bytes (and thus the txid) are unchanged. ──
  const sellerReady = btc.Transaction.fromPSBT(buyerSignedPsbtBytes);
  sellerReady.updateInput(0, { tapInternalKey: albyXOnly }, true);
  const sellerReadyPsbtBytes = sellerReady.toPSBT();

  // ── Alby (seller) signs input 0, finalizes, returns wire tx ──
  const acceptWireHex = await signPsbtViaAlby(seedPage, bytesHex(sellerReadyPsbtBytes));
  const acceptTxid = await postTx(acceptWireHex);
  // eslint-disable-next-line no-console
  console.log(`[alby-accept-offer] accept broadcast txid = ${acceptTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  // ── Assert via electrs + parser (NEVER ord) ──
  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);

  // Cat lands at the buyer's address as a 546-sat output-0 UTXO.
  const boughtCat = await waitForUtxoMatching(
    buyerAddress,
    u => u.txid === acceptTxid && u.vout === 0,
    `bought cat ${acceptTxid}:0 at ${buyerAddress}`,
  );
  expect(boughtCat.value).toBe(CAT21_POSTAGE_SATS);

  const parsed = Cat21ParserService.parse(acceptTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(acceptTxid);
  expect(parsed!.getImage()).toMatch(/^<svg/);
});

/* ─────────────────────────── helpers ─────────────────────────── */

function hexBytes(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}
