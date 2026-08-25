import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { Network, toScureNetwork } from '../../../src/network';
import { buildCat21MintPsbt } from '../../../src/cat21-mint/cat21-mint.helper';
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
  getUtxos,
  assertAllInputsSighashAll,
} from '../../regtest/regtest-helpers';

/**
 * Full CAT-21 CREATE-OFFER roundtrip with the real Alby Browser
 * Extension — Alby is the BUYER.
 *
 * Same SW-message bypass as `alby-mint-roundtrip.spec.ts`: seed Alby
 * via the LBE background-script router, then drive `webbtc/signPsbt`
 * directly from an extension-origin page (the React ConfirmSignPsbt
 * popup's confirm() never resolves headless).
 *
 * Flow (buyer-initiated ord-style offer):
 *   1. Seed + connect Alby (single Taproot bcrt1p address).
 *   2. Fund Alby.
 *   3. Synthesise + fund a raw-key SELLER (P2WPKH bcrt1q). Pure-SDK mint
 *      a cat at the seller (raw key signs input 0). Cat lives on the
 *      seller's bcrt1q UTXO.
 *   4. Build the buy-offer PSBT via the real SDK builder: input 0 =
 *      seller's cat (UNSIGNED on emit), input 1 = Alby's funding UTXO.
 *      Alby signs input 1 via the SW bypass.
 *   5. Seller raw-key signs input 0, finalize, broadcast.
 *   6. Assert via electrs + parser (NEVER ord): the 546-sat output-0
 *      UTXO lands at Alby's buyer-receive address, lockTime=21,
 *      SIGHASH_ALL on every input, tx parses as CAT-21.
 *
 * The Alby CI shard runs bitcoind + electrs ONLY (no cat21-ord), so
 * ownership is proven by electrs' UTXO set — not by an ord lookup.
 *
 * Whether Alby can play the buyer role at all is the open question this
 * spec answers empirically. Alby's `signPsbt` signs EVERY input with
 * its single Taproot key and FINALIZES the whole PSBT (verified against
 * background.bundle.js; see `src/wallet/signers/alby.signer.ts`). A
 * buyer-initiated offer needs the OPPOSITE: sign ONLY input 1, leave
 * input 0 (the seller's cat) unsigned for the seller to complete later.
 * This spec builds the flow faithfully and lets CI reveal whether
 * Alby's webbtc/signPsbt can produce a buyer-partial PSBT or whether it
 * finalizes / rejects. Do NOT read a green-once run as "supported".
 *
 * Build note: no build-only Alby harness entry exists for createOffer
 * (harness ships mint/inscribe only; its generic `runOperation` throws
 * for Alby). The offer PSBT is built directly here via the real SDK
 * `buildCat21BuyOfferPsbt` — same pure builder, identical bytes — the
 * counterparty-build pattern the `cat21wallet-*-offer` specs use.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPassword123!';
const EXPECTED_REGTEST_TAPROOT = 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg';

const FUND_AMOUNT_BTC = 0.001;
const SELLER_FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const OFFER_FEE_SATS = 1500;
const PRICE_SATS = 50_000;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;
let seedPage: Page;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-create-offer-${name}.png`),
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
 * Fire Alby's internal `webbtc/signPsbt` route from the extension-origin
 * seedPage and return the raw response. Unlike the mint/transfer helper,
 * the offer flow inspects the response shape itself (Alby is documented
 * to finalize + return wire-tx hex; the buyer role needs a partial-sig
 * PSBT), so this returns `{ data?, error? }` without throwing.
 */
async function albySignRaw(page: Page, psbtHex: string): Promise<{ data?: { signed: string }; error?: string }> {
  const res = await page.evaluate(async (psbt) => {
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
  console.log(`[alby-create-offer] signPsbt response = ${JSON.stringify(res).slice(0, 400)}`);
  return res;
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

test('create a CAT-21 buy-offer on regtest via Alby (buyer): seller raw-key mints, Alby signs its funding input, seller signs input 0', async () => {
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

  // ── Connect Alby ──
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
  console.log(`[alby-create-offer] buyer(alby) address=${connectInfo.address} publicKey=${connectInfo.publicKey}`);
  expect(connectInfo.address).toBe(EXPECTED_REGTEST_TAPROOT);
  const albyAddress = connectInfo.address;
  const albyPubBytes = hexBytes(connectInfo.publicKey);
  const albyXOnly = albyPubBytes.length === 32 ? albyPubBytes : albyPubBytes.slice(1, 33);
  const albyTaprootScript = btc.p2tr(albyXOnly, undefined, regtestNetwork).script;

  // ── Fund Alby (the buyer) ──
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', albyAddress, String(FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const buyerFundUtxo = await waitForUtxoAt(albyAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ── Synthesise SELLER (raw P2WPKH), fund, pure-SDK mint a cat ──
  const sellerPriv = secp256k1.utils.randomPrivateKey();
  const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
  const sellerP2 = btc.p2wpkh(sellerPub, regtestNetwork);
  const sellerAddress = sellerP2.address!;
  const sellerScript = sellerP2.script;

  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', sellerAddress, String(SELLER_FUND_AMOUNT_BTC));
  await waitForElectrsSync(mineBlocks(1));
  const sellerFundUtxo = await waitForUtxoAt(sellerAddress, Math.round(SELLER_FUND_AMOUNT_BTC * 1e8));

  // Seller mints with a non-cat21wallet walletType (third-party parity).
  const mintBuilt = buildCat21MintPsbt({
    walletType: KnownOrdinalWalletType.xverse,
    network: Network.Regtest,
    fundingInput: {
      txid: sellerFundUtxo.txid,
      vout: sellerFundUtxo.vout,
      value: sellerFundUtxo.value,
      scriptPubKey: sellerScript,
    },
    destinations: {
      recipientAddress: sellerAddress,
      senderChangeAddress: sellerAddress,
    },
    feeSats: MINT_FEE_SATS,
  });
  const mintTx = btc.Transaction.fromPSBT(mintBuilt.psbt);
  mintTx.signIdx(sellerPriv, 0, [btc.SigHash.ALL]);
  mintTx.finalize();
  const mintTxid = await postTx(mintTx.hex);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(mintTxid);
  const sellerCatUtxo = await waitForUtxoMatching(
    sellerAddress,
    u => u.txid === mintTxid && u.vout === 0,
    `seller cat ${mintTxid}:0`,
  );
  expect(sellerCatUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[alby-create-offer] seller cat ${mintTxid}:0 at ${sellerAddress}`);

  // ── Build the buy-offer PSBT (input 0 seller cat, input 1 Alby funding) ──
  const offer = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.alby,
    network: Network.Regtest,
    sellerInput: {
      txid: mintTxid,
      vout: 0,
      value: CAT21_POSTAGE_SATS,
      scriptPubKey: sellerScript,
    },
    buyerInputs: [{
      txid: buyerFundUtxo.txid,
      vout: buyerFundUtxo.vout,
      value: buyerFundUtxo.value,
      scriptPubKey: albyTaprootScript,
      tapInternalKey: albyXOnly,
    }],
    destinations: {
      buyerReceiveAddress: albyAddress,
      sellerPaymentAddress: sellerAddress,
      buyerChangeAddress: albyAddress,
    },
    priceSats: PRICE_SATS,
    feeSats: OFFER_FEE_SATS,
  });

  // ── Alby (buyer) signs its funding input via the SW bypass ──
  // Faithful attempt: hand Alby the full offer PSBT. A correct buyer
  // signs ONLY input 1 and returns a partial-sig PSBT with input 0 (the
  // seller's cat) still open. Alby's signPsbt signs every input with its
  // Taproot key and finalizes, so this call is expected to either reject
  // (it can't Taproot-sign the seller's P2WPKH input 0) or return a
  // finalized wire tx the seller can no longer complete. CI reveals which.
  const signRes = await albySignRaw(seedPage, bytesHex(offer.psbt));
  if (signRes.error || !signRes.data?.signed) {
    throw new Error(
      `Alby webbtc/signPsbt rejected the buy-offer PSBT (buyer-partial signing unsupported): ${JSON.stringify(signRes)}`,
    );
  }

  // Interpret Alby's response. The create-offer flow needs a PSBT the
  // SELLER can still add input 0's signature to. Alby is documented to
  // return a finalized wire-tx hex — try PSBT first, fail loudly if it's
  // a wire tx (offer-create is impossible when the buyer's signer
  // finalizes the whole tx).
  let buyerSignedPsbtBytes: Uint8Array;
  try {
    const asPsbt = btc.Transaction.fromPSBT(hexBytes(signRes.data.signed));
    buyerSignedPsbtBytes = asPsbt.toPSBT();
  } catch {
    throw new Error(
      'Alby returned a finalized wire tx from webbtc/signPsbt, not a buyer-partial PSBT. ' +
      'Offer-create (buyer signs input 1, seller completes input 0) requires partial signing ' +
      'that Alby does not expose. See src/wallet/signers/alby.signer.ts.',
    );
  }

  // Seller-side validator gate — same check the seller wallet runs
  // before signing input 0.
  const validation = validateCat21BuyOfferPsbt({
    psbt: buyerSignedPsbtBytes,
    expectedSellerUtxo: { txid: mintTxid, vout: 0 },
    floorPriceSats: PRICE_SATS,
    expectedSellerPaymentAddress: sellerAddress,
    network: Network.Regtest,
  });
  expect(validation.ok).toBe(true);

  // ── Seller raw-key signs input 0, finalize, broadcast ──
  const finalTx = btc.Transaction.fromPSBT(buyerSignedPsbtBytes);
  finalTx.signIdx(sellerPriv, 0, [btc.SigHash.ALL]);
  finalTx.finalize();
  const acceptTxid = await postTx(finalTx.hex);
  // eslint-disable-next-line no-console
  console.log(`[alby-create-offer] offer-acceptance broadcast txid = ${acceptTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  // ── Assert via electrs + parser (NEVER ord) ──
  const acceptTx = await waitForTxConfirmed(acceptTxid);
  expect(acceptTx.locktime).toBe(21);
  expect(acceptTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(acceptTx);

  // Cat lands at Alby's buyer-receive address as a 546-sat output-0 UTXO.
  const boughtCat = await waitForUtxoMatching(
    albyAddress,
    u => u.txid === acceptTxid && u.vout === 0,
    `bought cat ${acceptTxid}:0 at ${albyAddress}`,
  );
  expect(boughtCat.value).toBe(CAT21_POSTAGE_SATS);

  // Seller was paid priceSats + postage at output 1.
  const sellerPayment = (await getUtxos(sellerAddress)).find(u => u.txid === acceptTxid);
  expect(sellerPayment).toBeTruthy();
  expect(sellerPayment!.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);

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
