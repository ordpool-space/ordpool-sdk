import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../../../src/network';

import {
  waitForElectrsSync,
  waitForUtxoAt,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
  assertAllInputsSighashAll,
  waitForOrdReady,
  waitForOrdSync,
  waitForCatAtAddress,
  catInscriptionId,
  getUtxos,
} from '../../regtest/regtest-helpers';
import { waitForApprovalPopup, closeLeftoverExtensionPages } from '../approval-popup';
import { approveCat21WalletSignPopup } from '../cat21wallet-sign-popup';

/**
 * Cat21 Wallet TRANSFER roundtrip on regtest — full popup-driven path.
 *
 * 1. Onboard Cat21 Wallet with the BIP-39 test seed.
 * 2. Open the harness, call connectCat21WalletRegtest → bcrt1q + bcrt1p
 *    addresses returned directly by the wallet (no mainnet-keys trick).
 * 3. Fund the bcrt1q via local bitcoind, mine, wait for electrs.
 * 4. Mint via SDK + wallet popup. Cat lands at the wallet's bcrt1p
 *    ordinals address; change lands at the bcrt1q payment address.
 * 5. Synthesise a destination keypair (raw P2WPKH).
 * 6. Build a transfer PSBT via SDK; signer pipes inputs through TWO
 *    sequential wallet popups (input 0 Taproot cat + input 1 P2WPKH
 *    funding). The harness captures the finalized wire tx; the spec
 *    broadcasts via local electrs.
 * 7. Mine, wait for ord. Assert the cat is now at the destination
 *    address, the wire tx carries lockTime=21 across all inputs
 *    under SIGHASH_ALL, and Cat21ParserService still parses the tx as
 *    a CAT-21 (every cat-touching tx we build re-mints; transfer is
 *    just another mint structurally).
 *
 * Why this matters: signTransfer is one of the four operations the
 * cat21-wallet's MCP / popup surface dispatches. The wallet-side unit
 * tests pin the adapter shape against a mocked signPsbt RPC; this spec
 * pins the contract end-to-end: real bitcoind, real electrs, real
 * cat21-ord, real Cat21 Wallet binary, real popup approvals.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/cat21wallet');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';

const FUND_AMOUNT_BTC = 0.001;
const MINT_FEE_SATS = 1500;
const TRANSFER_FEE_SATS = 1500;
const CAT21_POSTAGE_SATS = 546;

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `cat21wallet-transfer-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

async function onboardCat21Wallet(page: Page): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-in-link')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sign-in-link').click();

  const inputs = page.locator('input[type="text"], input[type="password"]');
  await expect(inputs.first()).toBeVisible({ timeout: 15_000 });
  const words = TEST_MNEMONIC.split(' ');
  for (let i = 0; i < 12; i++) {
    await inputs.nth(i).fill(words[i]);
  }
  await page.getByRole('button', { name: /continue|sign in|restore|confirm/i }).first().click();

  const pwInput = page.getByTestId('set-or-enter-password-input');
  await expect(pwInput).toBeVisible({ timeout: 15_000 });
  await pwInput.click();
  await pwInput.pressSequentially(TEST_PASSWORD, { delay: 15 });
  await page.getByTestId('set-password-btn').click();

  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return t.includes('send') || t.includes('receive') || t.includes('balance') || t.includes('bitcoin');
  }, undefined, { timeout: 30_000, polling: 250 });
}

async function approveConnectPopup(ctx: BrowserContext, knownPages: Set<Page>): Promise<void> {
  const approval = await waitForApprovalPopup({
    context: ctx,
    knownPages,
    isApproval: async (p) => {
      if (!p.url().startsWith('chrome-extension://')) return false;
      await p.getByTestId('get-addresses-approve-button')
        .waitFor({ state: 'visible', timeout: 60_000 });
      return true;
    },
  });
  await approval.getByTestId('get-addresses-approve-button').click();
}

/**
 * Wait for a sign-PSBT popup, ASSERT its content (not just "any popup
 * with a Confirm button"), and approve.
 *
 * Content gates (closes points 2 / 3 / 14 of the audit):
 *  - URL contains `RpcSignPsbt` route → confirms it's the sign-psbt
 *    popup, not some other request popup that happens to have a
 *    Confirm button.
 *  - URL contains `signAtIndex=${expectedSignAtIndex}` → confirms the
 *    wallet is signing the input we expect (transfer fires TWO popups,
 *    one per input; this pins which popup approves which signing
 *    position).
 *  - The `psbt-signer-card` testid is visible → structural proof the
 *    sign-psbt UI rendered (vs. an error / loading / blank screen).
 *
 * The "approve any button matching /^(confirm|sign|approve)$/i" pattern
 * is preserved as the final action because the wallet doesn't expose
 * a stable testid on the confirm button yet.
 */
async function approveSignPopup(
  ctx: BrowserContext,
  knownPages: Set<Page>,
  screenshotTag: string,
  expectedSignAtIndex: number,
): Promise<void> {
  await approveCat21WalletSignPopup({
    context: ctx,
    knownPages,
    screenshot: p => shot(p, screenshotTag),
    expectedSignAtIndex,
  });
}

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Cat21 Wallet extension not unpacked at ${EXT_PATH}.`);
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

  const onboardPage = await context.newPage();
  await onboardCat21Wallet(onboardPage);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('transfer a cat21 on regtest via Cat21 Wallet: mint via popup, transfer via popup (2 sign approvals), broadcast', async () => {
  test.setTimeout(600_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await shot(harness, '01-harness-loaded');

  // ── Connect on mainnet; derive regtest equivalents inline ──
  // Cat21 Wallet's `getAddresses` `network: 'regtest'` parameter is
  // not honored by the shipping binary — it returns mainnet addresses
  // either way. The cross-network-keys trick used by Leather/Unisat
  // /OKX/Wizz/Oyl applies here too: cat21-wallet inherits Leather's
  // universal coin-type-0 derivation, so the bcrt1q / bcrt1p script
  // bytes derived from the mainnet pubkeys are identical to what the
  // wallet computes internally on regtest — only the bech32 HRP
  // differs. The wallet's signPsbt matches by script bytes, so a
  // PSBT carrying regtest-HRP addresses signs cleanly under
  // network='regtest'.
  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectCat21Wallet());
  await approveConnectPopup(context, connectKnownPages);
  const walletMainnet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);
  const regtestNetwork = toScureNetwork(Network.Regtest);
  const regtestPaymentAddress = btc.p2wpkh(hexBytes(walletMainnet.paymentPublicKey), regtestNetwork).address!;
  const regtestOrdinalsAddress = btc.p2tr(hexBytes(walletMainnet.ordinalsPublicKey), undefined, regtestNetwork).address!;
  const wallet = {
    ...walletMainnet,
    paymentAddress: regtestPaymentAddress,
    ordinalsAddress: regtestOrdinalsAddress,
  };
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] regtest payment  = ${wallet.paymentAddress}`);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] regtest ordinals = ${wallet.ordinalsAddress}`);
  expect(wallet.paymentAddress).toMatch(/^bcrt1q/);
  expect(wallet.ordinalsAddress).toMatch(/^bcrt1p/);

  // ── Fund the wallet's bcrt1q with a single 0.001 BTC UTXO ──
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', wallet.paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  const tipAfterFund = mineBlocks(1);
  await waitForElectrsSync(tipAfterFund);
  await waitForOrdReady();
  await waitForOrdSync(tipAfterFund);
  const fundUtxo = await waitForUtxoAt(wallet.paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] funded via ${fundTxid}, using ${fundUtxo.txid}:${fundUtxo.vout} (${fundUtxo.value} sats)`);

  // ── Step 1: MINT via the wallet (1 sign popup) ──
  const mintSignKnown = new Set(context.pages());
  const mintSignedPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'mint' as const,
      walletType: 'cat21wallet' as const,
      utxo: { txid: fundUtxo.txid, vout: fundUtxo.vout, value: fundUtxo.value },
      paymentAddress: wallet.paymentAddress,
      paymentPublicKey: wallet.paymentPublicKey,
      recipientAddress: wallet.ordinalsAddress,
      feeSats: MINT_FEE_SATS,
    },
  );
  await approveSignPopup(context, mintSignKnown, '02-mint-sign-approval', /* signAtIndex */ 0);
  const minted = await mintSignedPromise;
  if (minted.kind !== 'mint') throw new Error('expected mint result');
  const mintTxid = await postTx(minted.txHex);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] mint broadcast txid = ${mintTxid}`);
  const tipAfterMint = mineBlocks(1);
  await waitForElectrsSync(tipAfterMint);
  await waitForOrdSync(tipAfterMint);
  const mintTx = await waitForTxConfirmed(mintTxid);
  // Locktime + SIGHASH_ALL still pinned (the canonical CAT-21 marker
  // and the seller-signs-the-whole-tx commitment).
  expect(mintTx.locktime).toBe(21);
  assertAllInputsSighashAll(mintTx);
  // Locktime-preservation regression: the on-chain txid MUST equal the
  // txid computed from the UNSIGNED PSBT (before the wallet saw it).
  // SegWit's txid is witness-independent (BIP-141), so this proves the
  // wallet didn't tamper with inputs/outputs/locktime/sequence between
  // unsigned-and-handed-to-popup and broadcast. Closes audit point 12.
  expect(mintTxid, 'wallet must not modify non-witness bytes (mint)').toBe(minted.expectedTxid);
  // Fee assertion (closes audit point 8): the actual on-chain fee
  // equals the requested fee exactly. The funding UTXO (100k sats)
  // is large enough that change is above dust, so no sub-dust absorb.
  expect(mintTx.fee, `mint fee = ${MINT_FEE_SATS} sats`).toBe(MINT_FEE_SATS);
  // Sequence assertion (closes audit point 9): every vin sequence
  // equals 0xfffffffd per the cat21-wallet RBF policy. A bug that
  // dropped to 0xffffffff (final, no RBF) would silently break the
  // wallet's accelerate flow on real Bitcoin.
  assertEveryInputSequence(mintTx, 0xfffffffd, 'mint');

  const inscriptionId = catInscriptionId(mintTxid);
  const mintedInscription = await waitForCatAtAddress(inscriptionId, wallet.ordinalsAddress);
  expect(mintedInscription.address).toBe(wallet.ordinalsAddress);
  expect(mintedInscription.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] cat #${mintedInscription.number} at ${wallet.ordinalsAddress}`);

  // ── Step 2: identify the cat UTXO (vout 0) + change UTXO (vout 1) ──
  const ordUtxos = await getUtxos(wallet.ordinalsAddress);
  const catUtxo = ordUtxos.find(u => u.txid === mintTxid && u.vout === 0);
  if (!catUtxo) throw new Error('cat UTXO not found at ordinalsAddress');
  expect(catUtxo.value).toBe(CAT21_POSTAGE_SATS);

  const payUtxos = await getUtxos(wallet.paymentAddress);
  const changeUtxo = payUtxos.find(u => u.txid === mintTxid);
  if (!changeUtxo) throw new Error('mint change UTXO not found at paymentAddress');
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] cat utxo ${catUtxo.txid}:${catUtxo.vout} | change utxo ${changeUtxo.txid}:${changeUtxo.vout} (${changeUtxo.value} sats)`);

  // ── Step 3: synthesise a destination keypair (raw P2WPKH on regtest) ──
  const destPriv = secp256k1.utils.randomPrivateKey();
  const destPub = secp256k1.getPublicKey(destPriv, true);
  const destP2 = btc.p2wpkh(destPub, toScureNetwork(Network.Regtest));
  const destinationAddress = destP2.address!;
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] destination address = ${destinationAddress}`);

  // ── Step 4: build scriptPubKey + tapInternalKey for the cat input ──
  // The Taproot scriptPubKey is OP_1 || 0x20 || OUTPUT key — the
  // BIP-86 TWEAKED key, not the internal key. `p2tr(internalKey, …)`
  // does the tweak for us and returns the on-chain `script` field.
  // The `tapInternalKey` field in the PSBT carries the UNTWEAKED
  // internal key (so the wallet can re-derive the tweak when signing).
  const ordinalsXOnlyHex = wallet.ordinalsPublicKey;
  if (ordinalsXOnlyHex.length !== 64) {
    throw new Error(`expected x-only ordinalsPublicKey, got ${ordinalsXOnlyHex.length} hex chars`);
  }
  const ordinalsXOnly = hexBytes(ordinalsXOnlyHex);
  const catP2 = btc.p2tr(ordinalsXOnly, undefined, toScureNetwork(Network.Regtest));
  const catScriptPubKeyHex = bytesHex(catP2.script);
  // Payment address scriptPubKey: P2WPKH = OP_0 (0x00) + 0x14 + HASH160(pubkey)
  const payPubBytes = hexBytes(wallet.paymentPublicKey);
  const payP2 = btc.p2wpkh(payPubBytes, toScureNetwork(Network.Regtest));
  const fundingScriptPubKeyHex = bytesHex(payP2.script);

  // ── Step 5: TRANSFER via the wallet (2 sign popups: cat-input then funding) ──
  // The cat21wallet signer's signMultiInputAndBroadcast iterates over
  // signing-map indices, calling Cat21Provider.request('signPsbt') once
  // per index — each call shows a popup. Queue both approvals before
  // awaiting the promise.
  const transferSignKnown = new Set(context.pages());
  const transferSignedPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'transfer' as const,
      walletType: 'cat21wallet' as const,
      catInput: {
        txid: catUtxo.txid,
        vout: catUtxo.vout,
        value: catUtxo.value,
        scriptPubKeyHex: catScriptPubKeyHex,
        tapInternalKeyHex: ordinalsXOnlyHex,
      },
      fundingInputs: [{
        txid: changeUtxo.txid,
        vout: changeUtxo.vout,
        value: changeUtxo.value,
        scriptPubKeyHex: fundingScriptPubKeyHex,
      }],
      ordinalsAddress: wallet.ordinalsAddress,
      paymentAddress: wallet.paymentAddress,
      recipientAddress: destinationAddress,
      senderChangeAddress: wallet.paymentAddress,
      feeSats: TRANSFER_FEE_SATS,
    },
  );
  // Transfer fires TWO sign popups — one per input. The harness's
  // signMultiInputAndBroadcast iterates [0, 1] and calls signPsbt
  // with `signAtIndex: i` each time. We assert the popup URL carries
  // the expected index, so a wallet bug that double-signed the same
  // input (or skipped one) would be caught HERE rather than indirectly
  // via "broadcast failed". Closes audit points 3 + 14.
  await approveSignPopup(context, transferSignKnown, '03a-transfer-sign-cat-input',     /* signAtIndex */ 0);
  await approveSignPopup(context, transferSignKnown, '03b-transfer-sign-funding-input', /* signAtIndex */ 1);
  const transferred = await transferSignedPromise;
  if (transferred.kind !== 'transfer') throw new Error('expected transfer result');

  const transferTxid = await postTx(transferred.txHex);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] transfer broadcast txid = ${transferTxid}`);
  const tipAfterTransfer = mineBlocks(1);
  await waitForElectrsSync(tipAfterTransfer);
  await waitForOrdSync(tipAfterTransfer);

  const transferTx = await waitForTxConfirmed(transferTxid);
  expect(transferTx.locktime).toBe(21);
  expect(transferTx.status.block_hash).toBeTruthy();
  assertAllInputsSighashAll(transferTx);
  // Locktime-preservation: the wallet must not have mutated non-witness
  // bytes between unsigned PSBT and broadcast. Closes audit point 12.
  expect(transferTxid, 'wallet must not modify non-witness bytes (transfer)').toBe(transferred.expectedTxid);
  // Fee + sequence pins. Closes audit points 8 + 9.
  expect(transferTx.fee, `transfer fee = ${TRANSFER_FEE_SATS} sats`).toBe(TRANSFER_FEE_SATS);
  assertEveryInputSequence(transferTx, 0xfffffffd, 'transfer');

  // Authority for "did the cat move" is cat21-ord (closes audit point
  // 7). We dropped Cat21ParserService.parse() — that's the same module
  // that built the witness data, so parsing it back is circular. ord
  // is independent: it ingests blocks from bitcoind, applies its
  // CAT-21 indexing rules, and reports the new owner. Only ord can
  // honestly say "the cat is at address X now".
  const movedInscription = await waitForCatAtAddress(inscriptionId, destinationAddress);
  expect(movedInscription.address).toBe(destinationAddress);
  expect(movedInscription.value).toBe(CAT21_POSTAGE_SATS);
  expect(movedInscription.number).toBe(mintedInscription.number);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-transfer] cat #${movedInscription.number} now at ${destinationAddress}`);
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

/**
 * Assert every input on an on-chain tx carries the expected nSequence.
 * Cat21 Wallet's RBF policy pins all wallet-built tx inputs to
 * 0xfffffffd (RBF on, no time-locks). A drift to 0xffffffff (final, no
 * RBF) would silently break the wallet's mempool-accelerate flow on
 * real Bitcoin. The Esplora vin shape doesn't declare `sequence` in
 * regtest-helpers.ts's TypeScript interface, but electrs always
 * includes it in the JSON — narrow via cast on the unknown[].
 */
function assertEveryInputSequence(
  tx: { vin: unknown[] },
  expectedSequence: number,
  label: string,
): void {
  tx.vin.forEach((raw, i) => {
    const v = raw as { sequence?: number; is_coinbase?: boolean };
    if (v.is_coinbase) return;
    if (typeof v.sequence !== 'number') {
      throw new Error(`${label}: vin[${i}] missing sequence in electrs response`);
    }
    expect(v.sequence, `${label}: vin[${i}].sequence`).toBe(expectedSequence);
  });
}
