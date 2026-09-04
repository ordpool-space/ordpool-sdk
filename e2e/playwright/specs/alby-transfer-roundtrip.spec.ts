import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { installAlbyAutoApprove } from '../alby-auto-approve';
import { Network, toScureNetwork } from '../../../src/network';
import { buildCat21TransferPsbt } from '../../../src/cat21-transfer/cat21-transfer.helper';
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

import { seedAlbyAccount } from '../onboard-alby';

/**
 * Full cat21 TRANSFER roundtrip with the real Alby Browser Extension.
 *
 * Same SW-message bypass as `alby-mint-roundtrip.spec.ts`: seed Alby's
 * account state directly via the LBE background-script router, then
 * sign PSBTs by calling the internal `webbtc/signPsbt` route from an
 * extension-origin page — bypassing the React ConfirmSignPsbt popup
 * whose confirm() never resolves in headless CI.
 *
 * The Alby CI shard runs bitcoind + electrs ONLY (no cat21-ord), so
 * every assertion here reads electrs + `ordpool-parser` — never ord.
 * "Did the cat move" is proven by the 546-sat output-0 UTXO appearing
 * at the destination address in electrs' UTXO set, plus the on-chain
 * tx carrying `lockTime=21` under SIGHASH_ALL and parsing as a CAT-21.
 *
 * Why transfer is the Alby flow most likely to succeed: Alby is a
 * SINGLE Taproot-address wallet (m/86', bcrt1p) and its `signPsbt`
 * signs EVERY input with that one key (verified against Alby's
 * background.bundle.js; see `src/wallet/signers/alby.signer.ts`). A
 * self-transfer's inputs are BOTH the user's own Taproot UTXOs — the
 * cat UTXO (input 0) and the mint-change UTXO (input 1) — so Alby's
 * "sign everything with the Taproot key" is exactly right here. The
 * two offer roundtrips involve a raw-key P2WPKH counterparty input
 * that Alby would also try to Taproot-sign; those specs let CI reveal
 * that behaviour.
 *
 * Build note: there is no build-only Alby harness entry for transfer
 * (the harness ships `buildCat21MintPsbtForAlby` /
 * `buildInscribePsbtForAlby` only, and its generic `runOperation`
 * throws for Alby because signing goes through the SW bypass, not the
 * in-page signer). The transfer PSBT is therefore built directly in
 * this spec's Node context via the real SDK `buildCat21TransferPsbt`
 * — the same pure builder the harness would call, producing identical
 * bytes. This mirrors the counterparty-build pattern the
 * `cat21wallet-*-offer` specs already use.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/alby');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const EXPECTED_REGTEST_TAPROOT = 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg';

const FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const TRANSFER_FEE_SATS = 1500;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;
let seedPage: Page;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `alby-transfer-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

/**
 * Sign a PSBT (hex) via Alby's internal `webbtc/signPsbt` route from
 * the extension-origin seedPage — the exact SW-bypass call from
 * `alby-mint-roundtrip.spec.ts`. Alby signs every input with its
 * Taproot key, FINALIZES, and returns the wire-format raw tx hex in
 * `data.signed` (NOT a signed PSBT). Throws on any Alby-side error.
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
  console.log(`[alby-transfer] signPsbt response = ${JSON.stringify(signResult).slice(0, 400)}`);
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
  // KEEP seedPage open — the test uses it to talk to the SW directly.
});

test.afterAll(async () => {
  await context?.close();
});

test('transfer a cat21 on regtest via Alby: mint self-cat, sign transfer PSBT via SW bypass, broadcast + verify via electrs', async () => {
  test.setTimeout(300_000);

  // Auto-confirm the alby.enable() permission popup during connect.
  installAlbyAutoApprove(context);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // ── Connect: alby.enable() → alby.webbtc.getAddress() ──
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
  console.log(`[alby-transfer] address=${connectInfo.address} publicKey=${connectInfo.publicKey}`);
  expect(connectInfo.address).toBe(EXPECTED_REGTEST_TAPROOT);
  const albyAddress = connectInfo.address;

  // Alby's Taproot x-only internal key. The SDK normalises exactly this
  // way (`build-input-script.ts`): 32-byte x-only stays, 33-byte
  // compressed loses its parity byte. We need it to shape the cat +
  // funding inputs of the transfer PSBT so Alby recognises them.
  const albyPubBytes = hexBytes(connectInfo.publicKey);
  const albyXOnly = albyPubBytes.length === 32 ? albyPubBytes : albyPubBytes.slice(1, 33);
  const regtestNetwork = toScureNetwork(Network.Regtest);
  const albyTaprootScript = btc.p2tr(albyXOnly, undefined, regtestNetwork).script;

  // ── Fund Alby's Taproot address ──
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', albyAddress, String(FUND_AMOUNT_BTC)).trim();
  // eslint-disable-next-line no-console
  console.log(`[alby-transfer] funded ${albyAddress} in ${fundTxid}`);
  await waitForElectrsSync(mineBlocks(1));
  const fundUtxo = await waitForUtxoAt(albyAddress, Math.round(FUND_AMOUNT_BTC * 1e8));

  // ── Step 1: MINT a self-cat via Alby (harness build + SW-bypass sign) ──
  const mintBuild = await harness.evaluate((args) => {
    return window.ordpoolSdkHarness.buildCat21MintPsbtForAlby(args);
  }, {
    utxo: { txid: fundUtxo.txid, vout: fundUtxo.vout, value: fundUtxo.value },
    paymentAddress: albyAddress,
    paymentPublicKey: connectInfo.publicKey,
    recipientAddress: albyAddress, // self-recipient: cat + change both at Alby's Taproot
    feeSats: MINT_FEE_SATS,
  }).catch((e) => ({ error: String(e) } as { psbtHex?: string; error?: string }));
  if ('error' in mintBuild && mintBuild.error) {
    throw new Error(`harness mint PSBT build failed: ${mintBuild.error}`);
  }
  const mintWireHex = await signPsbtViaAlby(seedPage, (mintBuild as { psbtHex: string }).psbtHex);
  const mintTxid = await postTx(mintWireHex);
  // eslint-disable-next-line no-console
  console.log(`[alby-transfer] mint broadcast txid = ${mintTxid}`);
  await waitForElectrsSync(mineBlocks(1));
  const mintTx = await waitForTxConfirmed(mintTxid);
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  // Cat-sat mint guard: mint inputs must be RBF-final (>= 0xfffffffe) so
  // no external accelerate UI can drop the nLockTime=21 marker. Same
  // assertion the Alby mint roundtrip makes.
  for (const vin of mintTx.vin as Array<{ sequence: number }>) {
    expect(vin.sequence).toBeGreaterThanOrEqual(0xfffffffe);
  }

  // ── Step 2: identify the cat UTXO (vout 0, 546) + mint-change UTXO ──
  const catUtxo = await waitForUtxoMatching(
    albyAddress,
    u => u.txid === mintTxid && u.vout === 0,
    `cat utxo ${mintTxid}:0`,
  );
  expect(catUtxo.value).toBe(CAT21_POSTAGE_SATS);
  const changeUtxo = await waitForUtxoMatching(
    albyAddress,
    u => u.txid === mintTxid && u.vout === 1,
    `mint-change utxo ${mintTxid}:1`,
  );
  // eslint-disable-next-line no-console
  console.log(`[alby-transfer] cat ${catUtxo.txid}:${catUtxo.vout} | change ${changeUtxo.txid}:${changeUtxo.vout} (${changeUtxo.value} sats)`);

  // ── Step 3: synthesise a destination P2WPKH keypair (raw, regtest) ──
  const destPriv = secp256k1.utils.randomPrivateKey();
  const destPub = secp256k1.getPublicKey(destPriv, true);
  const destinationAddress = btc.p2wpkh(destPub, regtestNetwork).address!;
  // eslint-disable-next-line no-console
  console.log(`[alby-transfer] destination = ${destinationAddress}`);

  // ── Step 4: build the transfer PSBT via the real SDK builder ──
  // Cat input 0 + funding input 1 are BOTH Alby's Taproot UTXOs, carried
  // as Taproot prepared-inputs (scriptPubKey = tweaked output key,
  // tapInternalKey = Alby's x-only internal key). Alby's signPsbt signs
  // both with its single m/86' key.
  const built = buildCat21TransferPsbt({
    walletType: KnownOrdinalWalletType.alby,
    network: Network.Regtest,
    catUtxo: {
      txid: catUtxo.txid,
      vout: catUtxo.vout,
      value: catUtxo.value,
      scriptPubKey: albyTaprootScript,
      tapInternalKey: albyXOnly,
    },
    fundingInputs: [{
      txid: changeUtxo.txid,
      vout: changeUtxo.vout,
      value: changeUtxo.value,
      scriptPubKey: albyTaprootScript,
      tapInternalKey: albyXOnly,
    }],
    destinations: {
      recipientAddress: destinationAddress,
      senderChangeAddress: albyAddress,
    },
    feeSats: TRANSFER_FEE_SATS,
  });

  // ── Step 5: Alby signs the transfer PSBT (both inputs) via SW bypass ──
  const transferWireHex = await signPsbtViaAlby(seedPage, bytesHex(built.psbt));
  const transferTxid = await postTx(transferWireHex);
  // eslint-disable-next-line no-console
  console.log(`[alby-transfer] transfer broadcast txid = ${transferTxid}`);
  await waitForElectrsSync(mineBlocks(1));

  // ── Step 6: assert via electrs + parser (NEVER ord) ──
  const transferTx = await waitForTxConfirmed(transferTxid);
  expect(transferTx.locktime).toBe(21);
  expect(transferTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(transferTx);

  // Cat now lives at the destination as a 546-sat output-0 UTXO.
  const movedCat = await waitForUtxoMatching(
    destinationAddress,
    u => u.txid === transferTxid && u.vout === 0,
    `moved cat ${transferTxid}:0 at ${destinationAddress}`,
  );
  expect(movedCat.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[alby-transfer] cat moved to ${destinationAddress} at ${movedCat.txid}:${movedCat.vout}`);

  // Every cat-touching tx we build is structurally a fresh CAT-21 mint
  // (lockTime=21). The parser confirms the transfer tx re-mints a cat.
  const parsed = Cat21ParserService.parse(transferTx);
  expect(parsed).not.toBeNull();
  expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  expect(parsed!.transactionId).toBe(transferTxid);
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
