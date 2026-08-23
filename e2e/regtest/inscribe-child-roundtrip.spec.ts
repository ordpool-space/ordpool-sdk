/**
 * Parent/child (ord provenance) roundtrip on regtest, verified against a
 * REAL ord (`ord-stock`).
 *
 * This is the on-chain proof for `createChildInscribeTransactions`:
 *
 *   1. Inscribe a PARENT to an address WE control ("the wallet").
 *   2. Inscribe a CHILD that spends the parent UTXO (proving control) and
 *      returns it to the wallet, with the child's envelope carrying the
 *      `parent` tag.
 *   3. Prove via stock ord that:
 *      (a) the child's `parents` contains the parent id — the provenance
 *          link ord actually indexed;
 *      (b) the child is a normal, positive-numbered inscription with the
 *          `vindicated` charm (its envelope is on the non-first input —
 *          exactly how ord's own `wallet inscribe --parent` works);
 *      (c) the parent MOVED to the child reveal's output 0 and is STILL
 *          at the wallet address with its 546 sats — nothing lost;
 *      (d) that parent-return UTXO is on-chain + spendable by the wallet.
 *
 * cat21-ord (`--index-cat21`) ignores real envelopes, so provenance is
 * verified against `ord-stock` only. Requires the `ord-stock` profile:
 *   docker compose -f e2e/docker-compose.regtest.yml --profile ord-stock up -d
 */

import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { createInscribeTransactions, createChildInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  ElectrsUtxo,
  inscriptionId,
  mineBlocks,
  postTx,
  rpc,
  getStockOrdInscription,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForOrdStockInscription,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC per funding UTXO
const FEE_RATE = 5;
const PSBT_WALLET = 'ordpool-e2e';
function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

const scureRegtest = toScureNetwork(Network.Regtest);

/** Fund a fresh SegWit UTXO from the regtest wallet; returns its context. */
async function freshFunding(): Promise<{ address: string; pubkey: Uint8Array; utxo: ElectrsUtxo }> {
  const address = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
  const pubkey = hex.decode(JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', address)).pubkey);
  bitcoinCliPsbtWallet('sendtoaddress', address, '1.0');
  await waitForElectrsSync(mineBlocks(1));
  const utxo = await waitForUtxoAt(address, FUND_AMOUNT_SATS);
  return { address, pubkey, utxo };
}

/** Sign + broadcast a commit PSBT via bitcoin-cli; returns the commit txid. */
async function signAndBroadcastCommit(commitPsbt: Uint8Array, expectedTxid: string): Promise<string> {
  const processed = JSON.parse(bitcoinCliPsbtWallet(
    '-named', 'walletprocesspsbt', `psbt=${base64.encode(commitPsbt)}`, 'sign=true', 'finalize=true',
  ));
  expect(processed.complete).toBe(true);
  // Use BC's authoritative wire-tx hex; a scure round-trip corrupts the
  // envelope tap-leaf witness (see inscribe-ord-indexing-roundtrip.spec.ts).
  const txid = await postTx(btc.Transaction.fromRaw(hex.decode(processed.hex)).hex);
  expect(txid).toBe(expectedTxid);
  mineBlocks(1);
  await waitForTxConfirmed(txid);
  return txid;
}

/** Poll stock ord until the inscription's satpoint becomes `expectedSatpoint`. */
async function waitForOrdStockSatpoint(id: string, expectedSatpoint: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const insc = await getStockOrdInscription(id);
    last = insc.satpoint ?? '';
    if (insc.satpoint === expectedSatpoint) return insc;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`stock ord: ${id} still at ${last}, expected ${expectedSatpoint}`);
}

describe('inscribe child (ord provenance) roundtrip on regtest', () => {

  it('child spends + returns the parent; ord indexes the link, parent stays in the wallet', async () => {
    await waitForOrdStockReady(60_000);

    // Mine well past the regtest jubilee height (110) so both inscriptions
    // are post-jubilee, matching mainnet (always post-jubilee). SDK
    // envelopes use OP_N pushnum tags → ord marks them `vindicated`
    // post-jubilee (positive number) rather than `cursed` (negative).
    await waitForElectrsSync(mineBlocks(20));

    // The "wallet" that owns the parent: a key we control. It signs the
    // parent input on the child reveal AND receives the parent back.
    const walletKey = secp256k1.utils.randomPrivateKey();
    const walletXonly = schnorr.getPublicKey(walletKey);
    const walletP2tr = btc.p2tr(walletXonly, undefined, scureRegtest, true);
    const walletAddress = walletP2tr.address!;

    // ---- Phase A: inscribe the PARENT into the wallet ----
    const pf = await freshFunding();
    const parentBody = new TextEncoder().encode('<html><body>PARENT collection root</body></html>');
    const parent = createInscribeTransactions({
      paymentOutput: { txid: pf.utxo.txid, vout: pf.utxo.vout, value: pf.utxo.value, status: { confirmed: true } },
      paymentPublicKey: pf.pubkey,
      paymentAddress: pf.address,
      recipientAddress: walletAddress, // the parent lands in the wallet
      body: parentBody,
      contentType: 'text/html',
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    await signAndBroadcastCommit(parent.commitPsbt, parent.commitTxid);
    const parentRevealTxid = await postTx(parent.revealHex);
    expect(parentRevealTxid).toBe(parent.revealTxid);
    const parentTip = mineBlocks(1);
    await waitForElectrsSync(parentTip);
    await waitForTxConfirmed(parentRevealTxid);

    const parentId = inscriptionId(parentRevealTxid, 0);
    await waitForOrdStockSync(parentTip);
    const parentBefore = await waitForOrdStockInscription(parentId);
    expect(parentBefore.address).toBe(walletAddress);
    expect(parentBefore.satpoint).toBe(`${parentRevealTxid}:0:0`);
    expect(parentBefore.value).toBe(546);
    expect(parentBefore.number).toBeGreaterThanOrEqual(0); // post-jubilee: blessed or vindicated

    // ---- Phase B: inscribe the CHILD, spending + returning the parent ----
    const cf = await freshFunding();
    const childRecipientAddr = btc.p2tr(
      schnorr.getPublicKey(secp256k1.utils.randomPrivateKey()), undefined, scureRegtest, true,
    ).address!;
    const childBody = new TextEncoder().encode('<html><body>CHILD member #1</body></html>');
    const child = createChildInscribeTransactions({
      paymentOutput: { txid: cf.utxo.txid, vout: cf.utxo.vout, value: cf.utxo.value, status: { confirmed: true } },
      paymentPublicKey: cf.pubkey,
      paymentAddress: cf.address,
      recipientAddress: childRecipientAddr,
      body: childBody,
      contentType: 'text/html',
      feeRatePerVbyte: FEE_RATE,
      parentInscriptionId: parentId,
      parentUtxo: {
        utxo: {
          txid: parentRevealTxid,
          vout: 0,
          value: 546,
          scriptPubKey: walletP2tr.script,
          tapInternalKey: walletXonly,
        },
        returnAddress: walletAddress, // parent returns to the wallet
      },
      network: Network.Regtest,
    });
    await signAndBroadcastCommit(child.commitPsbt, child.commitTxid);

    // Sign the child reveal's PARENT input (0) with the wallet key. Input 1
    // (commit) is already ephemeral-finalized; finalize input 0 manually
    // from the key-path signature so we never re-run scure's finalize()
    // over the envelope tap-leaf witness (which would corrupt it).
    const revealTx = btc.Transaction.fromPSBT(child.revealPsbt);
    revealTx.signIdx(walletKey, 0);
    const parentSig = revealTx.getInput(0).tapKeySig;
    expect(parentSig).toBeDefined();
    revealTx.updateInput(0, { finalScriptWitness: [parentSig!] }, true);
    const childRevealTxid = await postTx(revealTx.hex);
    expect(childRevealTxid).toBe(child.revealTxid);
    const childTip = mineBlocks(1);
    await waitForElectrsSync(childTip);
    await waitForTxConfirmed(childRevealTxid);

    // ---- Phase C: prove via stock ord ----
    await waitForOrdStockSync(childTip);
    const childId = inscriptionId(childRevealTxid, 0);
    const childInsc = await waitForOrdStockInscription(childId);

    // (a) the provenance link ord actually indexed.
    expect(childInsc.parents ?? []).toContain(parentId);
    // (b) normal positive-numbered inscription, vindicated (non-first-input
    //     envelope) — exactly like ord's own `wallet inscribe --parent`.
    expect(childInsc.number).toBeGreaterThanOrEqual(0);
    expect(childInsc.charms ?? []).toContain('vindicated');
    // (c) the child landed on its recipient at 546.
    expect(childInsc.address).toBe(childRecipientAddr);
    expect(childInsc.value).toBe(546);

    // (d) the PARENT moved to the child reveal's output 0 and is STILL in
    //     the wallet with its 546 sats — nothing lost.
    const parentAfter = await waitForOrdStockSatpoint(parentId, `${childRevealTxid}:0:0`);
    expect(parentAfter.address).toBe(walletAddress);
    expect(parentAfter.value).toBe(546);

    // (e) that parent-return UTXO is genuinely on-chain at the wallet
    //     address (electrs), i.e. spendable by the wallet key.
    const parentReturnUtxo = await waitForUtxoAt(walletAddress, 546);
    expect(parentReturnUtxo.txid).toBe(childRevealTxid);
    expect(parentReturnUtxo.vout).toBe(0);
  }, 300_000);
});
