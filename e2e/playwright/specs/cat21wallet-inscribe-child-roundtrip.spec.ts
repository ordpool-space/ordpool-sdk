import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

import * as btc from '@scure/btc-signer';

import { InscriptionParserService } from 'ordpool-parser';

import { Network, toScureNetwork } from '../../../src/network';
import {
  waitForElectrsSync,
  waitForUtxoAt,
  waitForTxConfirmed,
  rpc,
  mineBlocks,
  postTx,
  getUtxos,
} from '../../regtest/regtest-helpers';
import { closeLeftoverExtensionPages } from '../approval-popup';
import { approveCat21WalletConnectPopup, approveCat21WalletSignPopup } from '../cat21wallet-sign-popup';
import { onboardCat21Wallet } from '../onboard-cat21wallet';

/**
 * Cat21 Wallet PARENT/CHILD inscribe roundtrip on regtest — full
 * popup-driven path. This is the Pipeline-B proof for the child flow:
 * that the REAL wallet binary can sign the child reveal's parent input
 * (a P2TR key-path spend at the ordinals address) while the sibling
 * commit input is already finalized with the ephemeral key.
 *
 * 1. Onboard Cat21 Wallet with the BIP-39 test seed; connect via the
 *    harness (mainnet keys), derive the regtest bcrt1q / bcrt1p from
 *    the same pubkeys (every cat21wallet spec uses this trick).
 * 2. Inscribe a PLAIN PARENT at the wallet's ordinals address (one sign
 *    popup for the commit; the reveal is ephemeral-signed by the SDK).
 *    Broadcast, confirm. The parent inscription now sits at
 *    `parentReveal:0`, 546 sats, at the ordinals address.
 * 3. Inscribe a CHILD: `createChildInscribeTransactions` builds a commit
 *    plus a reveal that SPENDS the parent UTXO (input 0) and RETURNS it
 *    to the same ordinals address (output 0), with the child at output 1.
 *    The wallet fires TWO sequential popups — commit funding input, then
 *    the reveal's parent input. Broadcast both, confirm.
 * 4. Verify via ordpool-parser: the child parses with the right content
 *    AND `getParents()` contains the parent id. On-chain: the parent
 *    returned to the ordinals address at `childReveal:0` (546 sats,
 *    nothing lost) and the child landed at `childReveal:1`.
 *
 * The reveal confirming AT ALL is the load-bearing proof: if the wallet
 * signed input 0 wrong, electrs rejects the reveal with a
 * mandatory-script-verify-flag-failed and the test fails at broadcast.
 *
 * The stock-ord side (ord actually indexing the parent→child link) is
 * proven independently in the SDK regtest e2e
 * `inscribe-child-roundtrip.spec.ts`; this spec's job is the WALLET
 * signature + on-chain preservation of the parent.
 */

const EXT_PATH = path.resolve(__dirname, '../../extensions/cat21wallet');
const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');
const HARNESS_URL = 'http://localhost:4500/';

const FUND_AMOUNT_BTC = 0.001;
const CAT21_POSTAGE_SATS = 546;
const PARENT_BODY_TEXT = 'cat21-wallet PARENT collection root';
const CHILD_BODY_TEXT = 'cat21-wallet CHILD of the collection';
const CONTENT_TYPE = 'text/plain;charset=utf-8';

let context: BrowserContext;
let extensionId: string;

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({
    path: path.resolve(RESULTS_DIR, `cat21wallet-inscribe-child-${name}.png`),
    fullPage: true,
  }).catch(() => undefined);
}

function utf8ToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
}
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

/** Fund the wallet's payment address with a fresh UTXO and return it. */
async function fundPaymentAddress(paymentAddress: string): Promise<{ txid: string; vout: number; value: number }> {
  const fundTxid = rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', paymentAddress, String(FUND_AMOUNT_BTC)).trim();
  await waitForElectrsSync(mineBlocks(1));
  await waitForUtxoAt(paymentAddress, Math.round(FUND_AMOUNT_BTC * 1e8));
  const utxos = await getUtxos(paymentAddress);
  const u = utxos.find(x => x.txid === fundTxid);
  if (!u) throw new Error(`funding UTXO ${fundTxid} not found at ${paymentAddress}`);
  return { txid: u.txid, vout: u.vout, value: u.value };
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
  await onboardCat21Wallet(onboardPage, extensionId);
  await shot(onboardPage, '00-onboarded');
});

test.afterAll(async () => {
  await context?.close();
});

test('inscribe a parent then a child via Cat21 Wallet: wallet signs the reveal parent input, parent returns to the wallet, child links to it', async () => {
  test.setTimeout(600_000);

  const harness = await context.newPage();
  await harness.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(
    () => (window as unknown as { ordpoolSdkHarnessReady?: true }).ordpoolSdkHarnessReady === true,
    undefined,
    { timeout: 15_000 },
  );

  // ── Connect on mainnet; derive regtest equivalents inline ──
  // cat21-wallet returns mainnet addresses regardless of the network
  // arg; the bcrt1q/bcrt1p script bytes derived from the same pubkeys
  // are identical to what the wallet computes internally on regtest
  // (only the bech32 HRP differs), and the wallet's signPsbt matches by
  // script bytes. Same trick every cat21wallet spec uses.
  const connectKnownPages = new Set(context.pages());
  const connectResultPromise = harness.evaluate(() => window.ordpoolSdkHarness.connectCat21Wallet());
  await approveCat21WalletConnectPopup(context, connectKnownPages);
  const walletMainnet = await connectResultPromise;
  await closeLeftoverExtensionPages(context, connectKnownPages);

  const regtestNetwork = toScureNetwork(Network.Regtest);
  const paymentAddress = btc.p2wpkh(hexBytes(walletMainnet.paymentPublicKey), regtestNetwork).address!;
  const ordinalsAddress = btc.p2tr(hexBytes(walletMainnet.ordinalsPublicKey), undefined, regtestNetwork).address!;
  expect(paymentAddress).toMatch(/^bcrt1q/);
  expect(ordinalsAddress).toMatch(/^bcrt1p/);

  // The parent's P2TR scriptPubKey (OP_1 || 0x20 || TWEAKED key) and its
  // UNTWEAKED tapInternalKey — the wallet re-derives the BIP-86 tweak on
  // sign. tapInternalKey = the wallet's x-only ordinals pubkey.
  const ordinalsXOnlyHex = walletMainnet.ordinalsPublicKey;
  expect(ordinalsXOnlyHex.length, 'x-only ordinals pubkey').toBe(64);
  const parentScriptPubKeyHex = bytesHex(btc.p2tr(hexBytes(ordinalsXOnlyHex), undefined, regtestNetwork).script);

  // ── Step 1: inscribe the PARENT at the ordinals address (1 popup) ──
  const parentFunding = await fundPaymentAddress(paymentAddress);
  const parentSignKnown = new Set(context.pages());
  const parentPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'inscribe' as const,
      walletType: 'cat21wallet' as const,
      utxo: parentFunding,
      paymentAddress,
      paymentPublicKey: walletMainnet.paymentPublicKey,
      recipientAddress: ordinalsAddress,
      bodyHex: utf8ToHex(PARENT_BODY_TEXT),
      contentType: CONTENT_TYPE,
      feeRatePerVbyte: 5,
    },
  );
  await approveCat21WalletSignPopup({
    context, knownPages: parentSignKnown, screenshot: p => shot(p, '01-parent-commit-sign'),
  });
  const parent = await parentPromise;
  if (parent.kind !== 'inscribe') throw new Error('expected inscribe result for parent');

  const parentCommitTxid = await postTx(parent.commitHex);
  expect(parentCommitTxid).toBe(parent.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(parentCommitTxid);

  const parentRevealTxid = await postTx(parent.revealHex);
  expect(parentRevealTxid).toBe(parent.revealTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(parentRevealTxid);
  const parentInscriptionId = `${parentRevealTxid}i0`;

  // The parent inscription UTXO now lives at the ordinals address.
  const ordUtxosAfterParent = await getUtxos(ordinalsAddress);
  const parentUtxo = ordUtxosAfterParent.find(u => u.txid === parentRevealTxid && u.vout === 0);
  if (!parentUtxo) throw new Error('parent inscription UTXO not found at ordinalsAddress');
  expect(parentUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-child] parent ${parentInscriptionId} at ${ordinalsAddress}`);

  // ── Step 2: inscribe the CHILD (2 popups: commit + reveal parent) ──
  const childFunding = await fundPaymentAddress(paymentAddress);
  const childSignKnown = new Set(context.pages());
  const childPromise = harness.evaluate(
    (args) => window.ordpoolSdkHarness.runOperation(args),
    {
      kind: 'inscribe-child' as const,
      walletType: 'cat21wallet' as const,
      utxo: childFunding,
      paymentAddress,
      paymentPublicKey: walletMainnet.paymentPublicKey,
      recipientAddress: ordinalsAddress,
      bodyHex: utf8ToHex(CHILD_BODY_TEXT),
      contentType: CONTENT_TYPE,
      feeRatePerVbyte: 5,
      parentInscriptionId,
      parentUtxo: {
        txid: parentUtxo.txid,
        vout: parentUtxo.vout,
        value: parentUtxo.value,
        scriptPubKeyHex: parentScriptPubKeyHex,
        tapInternalKeyHex: ordinalsXOnlyHex,
      },
      parentReturnAddress: ordinalsAddress,
    },
  );
  // TWO sequential popups; the helper adds each approved popup to the
  // shared set, so the second call skips the commit popup and catches
  // the reveal popup.
  await approveCat21WalletSignPopup({
    context, knownPages: childSignKnown, screenshot: p => shot(p, '02-child-commit-sign'),
  });
  await approveCat21WalletSignPopup({
    context, knownPages: childSignKnown, screenshot: p => shot(p, '03-child-reveal-parent-sign'),
  });
  const child = await childPromise;
  if (child.kind !== 'inscribe-child') throw new Error('expected inscribe-child result');
  expect(child.commitTxid).toMatch(/^[0-9a-f]{64}$/);
  expect(child.revealTxid).toMatch(/^[0-9a-f]{64}$/);
  expect(child.childInscriptionId).toBe(`${child.revealTxid}i0`);

  const childCommitTxid = await postTx(child.commitHex);
  expect(childCommitTxid).toBe(child.commitTxid);
  await waitForElectrsSync(mineBlocks(1));
  await waitForTxConfirmed(childCommitTxid);

  // The reveal confirming proves the wallet signed input 0 (the parent
  // P2TR key-path) correctly — a bad signature is rejected here with
  // mandatory-script-verify-flag-failed.
  const childRevealTxid = await postTx(child.revealHex);
  expect(childRevealTxid).toBe(child.revealTxid);
  await waitForElectrsSync(mineBlocks(1));
  const childRevealTx = await waitForTxConfirmed(childRevealTxid);
  expect(childRevealTx.status.block_hash).toBeTruthy();
  // SDK builder invariant (`buildChildInscribeRevealTx` throws if !== 21):
  // every SDK-built cat-touching tx sets lockTime=21. Not a protocol
  // requirement on a non-mint tx — the child inscription is preserved by
  // sat tracking regardless — but the SDK builder guarantees it.
  expect(childRevealTx.locktime).toBe(21);

  // ── Step 3: verify the child links the parent (ordpool-parser) ──
  const witnessHex = (childRevealTx as unknown as { vin: { witness: string[] }[] }).vin[1].witness;
  const parsed = InscriptionParserService.parse({ txid: childRevealTxid, vin: [{ witness: witnessHex }] });
  expect(parsed.length).toBe(1);
  expect(parsed[0].contentType).toBe(CONTENT_TYPE);
  expect(new TextDecoder().decode(parsed[0].getDataRaw())).toBe(CHILD_BODY_TEXT);
  expect(parsed[0].getParents()).toContain(parentInscriptionId);

  // ── Step 4: on-chain, the parent RETURNED to the wallet (nothing lost) ──
  const ordUtxosAfterChild = await getUtxos(ordinalsAddress);
  const parentReturn = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 0);
  if (!parentReturn) throw new Error('parent-return UTXO not found at ordinalsAddress after child reveal');
  expect(parentReturn.value).toBe(CAT21_POSTAGE_SATS);
  // The child itself landed at output 1, also at the ordinals address.
  const childUtxo = ordUtxosAfterChild.find(u => u.txid === childRevealTxid && u.vout === 1);
  if (!childUtxo) throw new Error('child UTXO not found at ordinalsAddress');
  expect(childUtxo.value).toBe(CAT21_POSTAGE_SATS);
  // The old parent outpoint is spent (the parent moved to childReveal:0).
  expect(ordUtxosAfterChild.find(u => u.txid === parentRevealTxid && u.vout === 0)).toBeUndefined();
  // eslint-disable-next-line no-console
  console.log(`[cat21wallet-child] child ${child.childInscriptionId}; parent returned at ${childRevealTxid}:0`);
});
