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
 * The last test drives a batch with two parents and compares the envelopes:
 * every envelope repeats both parent tags, and the pointers start after the
 * two parent outputs. The SDK's batch builder does not spend parents yet, so
 * that one compares the tapscript, built from the same field synthesiser.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { createBatchInscribeTransactions } from '../../src/inscribe/inscription-batch.helper';
import type { BatchInscribeMode, BatchInscriptionEntry } from '../../src/inscribe/inscription-batch.helper';
import { buildBatchInscriptionScript } from '../../src/inscribe/inscription-envelope';
import { synthesizeBatchEntryFields } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  fundUninscribed,
  getStockOrdContent,
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

  it('two parents: every envelope repeats both parent tags, pointers start after the parent outputs', async () => {
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

    // ord's reveal spends both parents first, so the commit is input 2, and
    // returns them at outputs 0 and 1 with their own values.
    const reveal = decode(ord.reveal);
    const parentValues = sats(reveal).slice(0, 2);
    const start = parentValues[0] + parentValues[1];

    const script = buildBatchInscriptionScript({
      revealPubkeyXonly: new Uint8Array(32).fill(7),
      envelopes: bodies.map((body, i) => ({
        body,
        contentType: 'text/plain;charset=utf-8',
        fields: synthesizeBatchEntryFields({ parents, pointer: start + postage * i }),
      })),
    });
    expect(hex.encode(script).slice(68)).toBe(ordEnvelopes(ord.reveal, 2));
  }, 240_000);
});
