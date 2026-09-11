/**
 * The batch builder's layout and refusals. Byte-parity with `ord wallet
 * batch` for every mode is proven on regtest in
 * e2e/regtest/inscribe-batch-parity.spec.ts; these pin what ord cannot be
 * made to produce and what a reader of the result relies on.
 */

import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { InscriptionParserService } from 'ordpool-parser';

import { Network, toScureNetwork } from '../network';

import { createBatchInscribeTransactions } from './inscription-batch.helper';
import type { CreateBatchInscribeTransactionsArgs } from './inscription-batch.helper';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);
const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const enc = (s: string) => new TextEncoder().encode(s);
const p2tr = (fill: number) => btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(fill)), undefined, scureNetwork, true).address!;

function base(overrides: Partial<CreateBatchInscribeTransactionsArgs>): CreateBatchInscribeTransactionsArgs {
  return {
    mode: 'separate-outputs',
    inscriptions: [
      { body: enc('one'), contentType: 'text/plain;charset=utf-8' },
      { body: enc('two'), contentType: 'text/plain;charset=utf-8' },
      { body: enc('three'), contentType: 'text/plain;charset=utf-8' },
    ],
    recipientAddress: p2tr(0xcd),
    paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 1_000_000, status: { confirmed: true } },
    paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
    paymentAddress: btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true).address!,
    feeRatePerVbyte: 3,
    network: NETWORK,
    ...overrides,
  };
}

function revealOutputs(revealHex: string): number[] {
  const tx = btc.Transaction.fromRaw(hex.decode(revealHex));
  return Array.from({ length: tx.outputsLength }, (_, i) => Number(tx.getOutput(i).amount));
}

describe('createBatchInscribeTransactions', () => {
  it('separate-outputs: one output per inscription, each at its own destination', () => {
    const own = p2tr(0x11);
    const r = createBatchInscribeTransactions(base({
      postageSats: 700,
      inscriptions: [
        { body: enc('one'), contentType: 'text/plain;charset=utf-8' },
        { body: enc('two'), contentType: 'text/plain;charset=utf-8', destination: own },
      ],
    }));
    expect(revealOutputs(r.revealHex)).toEqual([700, 700]);
    expect(r.inscriptions.map(l => [l.vout, l.offset, l.destination])).toEqual([
      [0, 0, base({}).recipientAddress],
      [1, 0, own],
    ]);
    expect(r.fees.commitOutputValueSats).toBe(1400 + r.fees.revealFeeSats);
  });

  it('shared-output: one output holding every postage, inscriptions one postage apart', () => {
    const r = createBatchInscribeTransactions(base({ mode: 'shared-output', postageSats: 600 }));
    expect(revealOutputs(r.revealHex)).toEqual([1800]);
    expect(r.inscriptions.map(l => [l.vout, l.offset])).toEqual([[0, 0], [0, 600], [0, 1200]]);
  });

  it('same-sat: one output of one postage, every inscription on its first sat', () => {
    const r = createBatchInscribeTransactions(base({ mode: 'same-sat', postageSats: 600 }));
    expect(revealOutputs(r.revealHex)).toEqual([600]);
    expect(r.inscriptions.map(l => [l.vout, l.offset])).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it('the reveal carries every inscription, in order, readable by ordpool-parser', () => {
    const r = createBatchInscribeTransactions(base({}));
    const witness = btc.Transaction.fromRaw(hex.decode(r.revealHex)).getInput(0).finalScriptWitness!.map(w => hex.encode(w));
    const parsed = InscriptionParserService.parse({ txid: r.revealTxid, vin: [{ witness }] });
    expect(parsed.map(p => new TextDecoder().decode(p.getDataRaw()))).toEqual(['one', 'two', 'three']);
  });

  it('refuses a per-inscription destination outside separate-outputs, as ord does', () => {
    for (const mode of ['shared-output', 'same-sat'] as const) {
      expect(() => createBatchInscribeTransactions(base({
        mode,
        inscriptions: [{ body: enc('x'), contentType: 'text/plain', destination: p2tr(0x22) }],
      }))).toThrow(`individual inscription destinations cannot be set in \`${mode}\` mode`);
    }
  });

  it('refuses an empty batch and a duplicate gallery item', () => {
    expect(() => createBatchInscribeTransactions(base({ inscriptions: [] }))).toThrow('at least one inscription');
    const id = `${'ab'.repeat(32)}i0`;
    expect(() => createBatchInscribeTransactions(base({
      inscriptions: [{ body: enc('x'), contentType: 'text/plain', gallery: [id, { id }] }],
    }))).toThrow('inscription 0: duplicate gallery item');
  });

  it('refuses a postage below the destination\'s dust limit instead of building a non-relayable reveal', () => {
    expect(() => createBatchInscribeTransactions(base({ postageSats: 100 })))
      .toThrow(/reveal output of 100 sats .* is below its 330-sat dust limit/);
  });
});
