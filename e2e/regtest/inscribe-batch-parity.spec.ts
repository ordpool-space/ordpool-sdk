/**
 * Batch parity with `ord wallet batch`, per mode and at more than one
 * postage.
 *
 * For each of `separate-outputs`, `shared-output` and `same-sat`, ord builds a
 * three-inscription batch and the SDK builds the same one. Compared, each of
 * which must match ord exactly:
 *
 *   the reveal tapscript   every envelope, in order, pointers included
 *   reveal output values   the per-mode output layout
 *   reveal vsize           follows from the two above plus the input shape
 *   commit output value    total postage + reveal fee, so it only matches if
 *                          everything before it does
 *
 * The whole transactions cannot be byte-identical: the reveal key is random,
 * each side funds from its own wallet, and our reveal carries `nLockTime=21`
 * plus a non-RBF sequence for the free cats.
 *
 * Then, per mode, an SDK batch is broadcast and stock ord must index every
 * inscription at the satpoint the SDK reports, with its content.
 *
 * With parents: ord builds a two-parent batch and the SDK builds the same
 * one against the same parent UTXOs, compared the same way (every envelope
 * repeats both parent tags; pointers start after the two parent outputs).
 * Then an SDK batch spending two parents we own is broadcast, and stock ord
 * must link every child to both parents and show both parents returned.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { createBatchChildInscribeTransactions, createBatchInscribeTransactions } from '../../src/inscribe/inscription-batch.helper';
import type { BatchInscribeMode, BatchInscriptionEntry, BatchParent } from '../../src/inscribe/inscription-batch.helper';
import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  fundUninscribed,
  getStockOrdContent,
  getStockOrdInscription,
  mineBlocks,
  fundOrdStockWallet,
  postTx,
  waitForOrdStockInscription,
  ordStockWalletBatch,
  ordStockWalletInscribe,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForUtxoAt,
  writeOrdStockFile,
} from './regtest-helpers';

// A fresh ord wallet per run. Every inscribe deposits into ord's own wallet,
// and reusing a wallet across runs grows a UTXO pool that eventually trips
// ord's coin-selection invariant (transaction_builder.rs, checked_sub on
// Target::Value). CI starts from a fresh stack; a reused local stack does not.
const ORD_WALLET = `parity-batch-stock-${Date.now().toString(36)}`;
const PSBT_WALLET = 'ordpool-e2e';
const FEE_RATE = 5;
const scureRegtest = toScureNetwork(Network.Regtest);
const enc = (s: string) => new TextEncoder().encode(s);

interface DecodedTx {
  vin: { txinwitness?: string[] }[];
  vout: { value: number }[];
  vsize: number;
}

function decode(txid: string): DecodedTx {
  return JSON.parse(rpc('getrawtransaction', txid, 'true')) as DecodedTx;
}

function sats(tx: DecodedTx): number[] {
  return tx.vout.map(o => Math.round(o.value * 1e8));
}

/** The reveal tapscript after `<pubkey> OP_CHECKSIG`, from the input spending the commit. */
function ordEnvelopes(revealTxid: string, commitInput: number): string {
  const tx = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', revealTxid)));
  return hex.encode(tx.getInput(commitInput).finalScriptWitness![1]).slice(68);
}

function randomP2tr(): string {
  return btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!;
}

describe('batch inscribe → parity with `ord wallet batch`', () => {
  let fundingAddr: string;
  let fundingPubkey: Uint8Array;
  let utxo: { txid: string; vout: number; value: number };
  let galleryItem: string;

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await fundOrdStockWallet(ORD_WALLET);

    // A gallery item that exists, since ord refuses references to missing ones.
    writeOrdStockFile('/tmp/parity-batch-item.txt', enc('batch gallery item'));
    galleryItem = `${ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-batch-item.txt', FEE_RATE).reveal}i0`;
    await waitForOrdStockSync(mineBlocks(1));

    // A real funded P2WPKH input for the SDK side. We only BUILD the SDK
    // transactions, so it is never spent here.
    fundingAddr = rpc('-rpcwallet=' + PSBT_WALLET, 'getnewaddress', '', 'bech32');
    fundingPubkey = hex.decode(JSON.parse(rpc('-rpcwallet=' + PSBT_WALLET, 'getaddressinfo', fundingAddr)).pubkey);
    rpc('-rpcwallet=' + PSBT_WALLET, 'sendtoaddress', fundingAddr, '1.0');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    const u = await waitForUtxoAt(fundingAddr, 100_000_000);
    utxo = { txid: u.txid, vout: u.vout, value: u.value };
  }, 240_000);

  it.each<[BatchInscribeMode, number]>([
    ['separate-outputs', 546],
    ['separate-outputs', 3000],
    ['shared-output', 546],
    ['shared-output', 3000],
    ['same-sat', 546],
    ['same-sat', 3000],
  ])('%s at %i sats postage: tapscript, reveal outputs, reveal vsize and commit output match ord', async (mode, postage) => {
    const tag = `${mode}-${postage}`;
    const bodies = [
      enc(`batch ${tag}: first`),
      enc(`<p>batch ${tag}: second</p>`),
      enc(`{"batch":"${tag}","n":3}`),
    ];
    writeOrdStockFile(`/tmp/pb-${tag}-a.txt`, bodies[0]);
    writeOrdStockFile(`/tmp/pb-${tag}-b.html`, bodies[1]);
    writeOrdStockFile(`/tmp/pb-${tag}-c.json`, bodies[2]);
    const destination = mode === 'separate-outputs' ? randomP2tr() : undefined;

    const yaml = [
      `mode: ${mode}`,
      `postage: ${postage}`,
      'inscriptions:',
      `  - file: /tmp/pb-${tag}-a.txt`,
      `  - file: /tmp/pb-${tag}-b.html`,
      `    title: second of ${tag}`,
      '    gallery:',
      `      - id: ${galleryItem}`,
      '        title: an item',
      `  - file: /tmp/pb-${tag}-c.json`,
      '    metaprotocol: parity',
      ...(destination ? [`    destination: ${destination}`] : []),
    ].join('\n');
    const ord = ordStockWalletBatch(ORD_WALLET, yaml, FEE_RATE);
    await waitForOrdStockSync(mineBlocks(1));
    const ordReveal = decode(ord.reveal);
    const ordCommit = decode(ord.commit);

    const inscriptions: BatchInscriptionEntry[] = [
      { body: bodies[0], contentType: 'text/plain;charset=utf-8' },
      {
        body: bodies[1],
        contentType: 'text/html;charset=utf-8',
        title: `second of ${tag}`,
        gallery: [{ id: galleryItem, title: 'an item' }],
      },
      { body: bodies[2], contentType: 'application/json', metaprotocol: 'parity', destination },
    ];
    const sdk = createBatchInscribeTransactions({
      mode,
      inscriptions,
      postageSats: postage,
      recipientAddress: randomP2tr(),
      paymentOutput: { ...utxo, status: { confirmed: true } },
      paymentPublicKey: fundingPubkey,
      paymentAddress: fundingAddr,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    const sdkReveal = btc.Transaction.fromRaw(hex.decode(sdk.revealHex));

    expect(hex.encode(sdk.commit.envelopeScript).slice(68)).toBe(ordEnvelopes(ord.reveal, 0));

    const sdkOutputs = Array.from({ length: sdkReveal.outputsLength }, (_, i) => Number(sdkReveal.getOutput(i).amount));
    expect(sdkOutputs).toEqual(sats(ordReveal));
    expect(sdk.fees.revealVsize).toBe(ordReveal.vsize);
    expect(sdk.fees.commitOutputValueSats).toBe(sats(ordCommit)[0]);

    // Where ord says each inscription is, the SDK says too.
    expect(sdk.inscriptions.map(l => `${ord.reveal}:${l.vout}:${l.offset}`))
      .toEqual(ord.inscriptions.map(i => i.location));
  }, 180_000);

  it.each<BatchInscribeMode>(['separate-outputs', 'shared-output', 'same-sat'])(
    '%s: an SDK batch broadcasts, and stock ord indexes every inscription where the SDK says it lands',
    async (mode) => {
      const { fundingAddr: addr, fundingPubkey: pubkey, utxo: clean } = await fundUninscribed();
      const bodies = [enc(`sdk ${mode}: a`), enc(`sdk ${mode}: b`), enc(`sdk ${mode}: c`)];
      const built = createBatchInscribeTransactions({
        mode,
        inscriptions: bodies.map(body => ({ body, contentType: 'text/plain;charset=utf-8' })),
        postageSats: 1000,
        recipientAddress: randomP2tr(),
        paymentOutput: { ...clean, status: { confirmed: true } },
        paymentPublicKey: pubkey,
        paymentAddress: addr,
        feeRatePerVbyte: FEE_RATE,
        network: Network.Regtest,
      });

      const processed = JSON.parse(rpc(
        '-rpcwallet=' + PSBT_WALLET, '-named', 'walletprocesspsbt',
        `psbt=${base64.encode(built.commitPsbt)}`, 'sign=true', 'finalize=true',
      )) as { complete: boolean; hex: string };
      expect(processed.complete).toBe(true);
      expect(await postTx(processed.hex)).toBe(built.commitTxid);
      expect(await postTx(built.revealHex)).toBe(built.revealTxid);
      const tip = mineBlocks(1);
      await waitForElectrsSync(tip);
      await waitForOrdStockSync(tip);

      for (const location of built.inscriptions) {
        const id = `${built.revealTxid}i${location.index}`;
        const insc = await waitForOrdStockInscription(id);
        expect(insc.satpoint).toBe(`${built.revealTxid}:${location.vout}:${location.offset}`);
        expect((await getStockOrdContent(id)).bytes).toEqual(bodies[location.index]);
      }
    },
    240_000,
  );

  it('two parents: the SDK batch matches ord in tapscript, reveal outputs, reveal vsize, commit output and locations', async () => {
    const parents: string[] = [];
    for (const n of [1, 2]) {
      writeOrdStockFile(`/tmp/pb-parent-${n}.txt`, enc(`batch parent ${n}`));
      parents.push(`${ordStockWalletInscribe(ORD_WALLET, `/tmp/pb-parent-${n}.txt`, FEE_RATE).reveal}i0`);
      await waitForOrdStockSync(mineBlocks(1));
    }
    const bodies = [enc('child one of two parents'), enc('child two of two parents')];
    writeOrdStockFile('/tmp/pb-child-1.txt', bodies[0]);
    writeOrdStockFile('/tmp/pb-child-2.txt', bodies[1]);
    const postage = 3000;
    const yaml = [
      'mode: separate-outputs',
      `postage: ${postage}`,
      'parents:',
      ...parents.map(p => `  - ${p}`),
      'inscriptions:',
      '  - file: /tmp/pb-child-1.txt',
      '  - file: /tmp/pb-child-2.txt',
    ].join('\n');
    const ord = ordStockWalletBatch(ORD_WALLET, yaml, FEE_RATE);
    await waitForOrdStockSync(mineBlocks(1));
    const ordReveal = decode(ord.reveal);
    const ordCommit = decode(ord.commit);

    // The SDK builds the same batch against the same two parent UTXOs (read
    // from ord's reveal inputs), returning each to where ord returned it.
    // Built only, never signed, so any x-only key stands in for the owner's.
    const revealInputs = (JSON.parse(rpc('getrawtransaction', ord.reveal, 'true')) as {
      vin: { txid: string; vout: number }[];
    }).vin;
    const revealOutputs = (JSON.parse(rpc('getrawtransaction', ord.reveal, 'true')) as {
      vout: { value: number; scriptPubKey: { address: string } }[];
    }).vout;
    const batchParents = [0, 1].map(i => {
      const prev = (JSON.parse(rpc('getrawtransaction', revealInputs[i].txid, 'true')) as {
        vout: { value: number; scriptPubKey: { hex: string } }[];
      }).vout[revealInputs[i].vout];
      return {
        id: parents[i],
        utxo: {
          txid: revealInputs[i].txid,
          vout: revealInputs[i].vout,
          value: Math.round(prev.value * 1e8),
          scriptPubKey: hex.decode(prev.scriptPubKey.hex),
          tapInternalKey: new Uint8Array(32).fill(i + 1),
        },
        returnAddress: revealOutputs[i].scriptPubKey.address,
      };
    });
    const sdk = createBatchChildInscribeTransactions({
      mode: 'separate-outputs',
      inscriptions: bodies.map(body => ({ body, contentType: 'text/plain;charset=utf-8' })),
      parents: batchParents,
      postageSats: postage,
      recipientAddress: randomP2tr(),
      paymentOutput: { ...utxo, status: { confirmed: true } },
      paymentPublicKey: fundingPubkey,
      paymentAddress: fundingAddr,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });

    // ord's reveal spends both parents first, so the commit is input 2.
    expect(hex.encode(sdk.commit.envelopeScript).slice(68)).toBe(ordEnvelopes(ord.reveal, 2));
    const sdkReveal = btc.Transaction.fromPSBT(sdk.revealPsbt, { allowUnknownInputs: true });
    const sdkOutputs = Array.from({ length: sdkReveal.outputsLength }, (_, i) => Number(sdkReveal.getOutput(i).amount));
    expect(sdkOutputs).toEqual(sats(ordReveal));
    expect(sdk.fees.revealVsize).toBe(ordReveal.vsize);
    expect(sdk.fees.commitOutputValueSats).toBe(sats(ordCommit)[0]);
    expect(sdk.inscriptions.map(l => `${ord.reveal}:${l.vout}:${l.offset}`))
      .toEqual(ord.inscriptions.map(i => i.location));
  }, 240_000);

  it('an SDK batch spending two parents broadcasts; stock ord links every child to both parents and returns both', async () => {
    // The parents' owner: a key we control, signing the parent inputs.
    const ownerKey = schnorr.utils.randomPrivateKey();
    const ownerXonly = schnorr.getPublicKey(ownerKey);
    const owner = btc.p2tr(ownerXonly, undefined, scureRegtest, true);

    const parents: BatchParent[] = [];
    for (const n of [1, 2]) {
      const f = await fundUninscribed();
      const parent = createInscribeTransactions({
        paymentOutput: { ...f.utxo, status: { confirmed: true } },
        paymentPublicKey: f.fundingPubkey,
        paymentAddress: f.fundingAddr,
        recipientAddress: owner.address!,
        body: enc(`sdk batch parent ${n}`),
        contentType: 'text/plain;charset=utf-8',
        postageSats: n === 1 ? 546 : 2000, // two sizes, so the pointer offset is not symmetric
        feeRatePerVbyte: FEE_RATE,
        network: Network.Regtest,
      });
      await signCommitAndBroadcast(parent.commitPsbt, parent.commitTxid);
      expect(await postTx(parent.revealHex)).toBe(parent.revealTxid);
      const tip = mineBlocks(1);
      await waitForElectrsSync(tip);
      await waitForOrdStockSync(tip);
      parents.push({
        id: `${parent.revealTxid}i0`,
        utxo: {
          txid: parent.revealTxid,
          vout: 0,
          value: n === 1 ? 546 : 2000,
          scriptPubKey: owner.script,
          tapInternalKey: ownerXonly,
        },
        returnAddress: owner.address!,
      });
    }

    const f = await fundUninscribed();
    const bodies = [enc('sdk child a'), enc('sdk child b'), enc('sdk child c')];
    const built = createBatchChildInscribeTransactions({
      mode: 'shared-output',
      inscriptions: bodies.map(body => ({ body, contentType: 'text/plain;charset=utf-8' })),
      parents,
      postageSats: 1000,
      recipientAddress: randomP2tr(),
      paymentOutput: { ...f.utxo, status: { confirmed: true } },
      paymentPublicKey: f.fundingPubkey,
      paymentAddress: f.fundingAddr,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    await signCommitAndBroadcast(built.commitPsbt, built.commitTxid);

    // What the wallet does in signChildRevealParentInputs with parentCount 2:
    // sign parent inputs 0 and 1 on the bare PSBT, then merge both
    // signatures into the full reveal and finalize.
    const walletFacing = btc.Transaction.fromPSBT(built.revealPsbtForWallet);
    const full = btc.Transaction.fromPSBT(built.revealPsbt, { allowUnknownInputs: true });
    for (const i of [0, 1]) {
      walletFacing.signIdx(ownerKey, i);
      const input = walletFacing.getInput(i);
      full.updateInput(i, { tapKeySig: input.tapKeySig ?? input.finalScriptWitness![0] }, true);
    }
    full.finalize();
    expect(await postTx(full.hex)).toBe(built.revealTxid);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);

    for (const location of built.inscriptions) {
      const id = `${built.revealTxid}i${location.index}`;
      const insc = await waitForOrdStockInscription(id);
      expect(insc.satpoint).toBe(`${built.revealTxid}:${location.vout}:${location.offset}`);
      expect(insc.parents).toEqual(parents.map(p => p.id));
      expect((await getStockOrdContent(id)).bytes).toEqual(bodies[location.index]);
    }
    for (const [i, parent] of parents.entries()) {
      const after = await getStockOrdInscription(parent.id);
      expect(after.satpoint).toBe(`${built.revealTxid}:${i}:0`);
      expect(after.address).toBe(owner.address!);
      expect(after.value).toBe(parent.utxo.value);
    }
  }, 300_000);
});

/** Sign an SDK commit with the funder wallet (walletprocesspsbt) and broadcast it. */
async function signCommitAndBroadcast(commitPsbt: Uint8Array, expectedTxid: string): Promise<void> {
  const processed = JSON.parse(rpc(
    '-rpcwallet=' + PSBT_WALLET, '-named', 'walletprocesspsbt',
    `psbt=${base64.encode(commitPsbt)}`, 'sign=true', 'finalize=true',
  )) as { complete: boolean; hex: string };
  expect(processed.complete).toBe(true);
  expect(await postTx(processed.hex)).toBe(expectedTxid);
}
