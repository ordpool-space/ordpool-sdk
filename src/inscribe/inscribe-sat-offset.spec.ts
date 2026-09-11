/**
 * `satOffset`: the padding output ord puts in front of a chosen sat. That the
 * inscription lands on the chosen sat is proven through stock ord's sat index
 * on regtest (e2e/regtest/inscribe-satpoint-parity.spec.ts); these pin the
 * commit layout and the refusals.
 */

import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';

import { createInscribeTransactions } from './inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from './inscription.service.helper';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);
const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const paymentAddress = btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true).address!;

function build(overrides: Partial<CreateInscribeTransactionsArgs>) {
  return createInscribeTransactions({
    paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
    paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
    paymentAddress,
    recipientAddress: btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(0xcd)), undefined, scureNetwork, true).address!,
    body: new TextEncoder().encode('onto a chosen sat'),
    contentType: 'text/plain',
    feeRatePerVbyte: 3,
    network: NETWORK,
    ...overrides,
  });
}

function outputs(psbt: Uint8Array): Array<[string, number]> {
  const tx = btc.Transaction.fromPSBT(psbt);
  return Array.from({ length: tx.outputsLength }, (_, i) => {
    const o = tx.getOutput(i);
    return [hex.encode(o.script!), Number(o.amount)];
  });
}

describe('satOffset', () => {
  it('puts a padding output of exactly the offset first, to the payment address, then the commit output', () => {
    const r = build({ satOffset: 5_000 });
    const outs = outputs(r.commitPsbt);
    const paymentScript = hex.encode(btc.OutScript.encode(btc.Address(scureNetwork).decode(paymentAddress)));
    expect(outs[0]).toEqual([paymentScript, 5_000]);
    expect(outs[1]).toEqual([hex.encode(r.commit.outputScript), r.commit.outputValueSats]);
    // The funding covers the padding too.
    expect(r.fees.fundingRequirementSats).toBe(5_000 + r.fees.commitOutputValueSats + r.fees.commitFeeSats);
  });

  it('the reveal spends the commit output at vout 1', () => {
    const r = build({ satOffset: 5_000 });
    const reveal = btc.Transaction.fromRaw(hex.decode(r.revealHex));
    expect(hex.encode(reveal.getInput(0).txid!)).toBe(r.commitTxid);
    expect(reveal.getInput(0).index).toBe(1);
  });

  it('offset 0 is the funding input\'s first sat: no padding output, commit output at vout 0', () => {
    const r = build({ satOffset: 0 });
    expect(outputs(r.commitPsbt)[0]).toEqual([hex.encode(r.commit.outputScript), r.commit.outputValueSats]);
    expect(btc.Transaction.fromRaw(hex.decode(r.revealHex)).getInput(0).index).toBe(0);
  });

  it('refuses a padding output below the payment address\'s dust limit', () => {
    expect(() => build({ satOffset: 100 })).toThrow(/satOffset 100 would make a padding output below the 330-sat dust limit/);
  });

  it('refuses an offset outside the funding input', () => {
    expect(() => build({ satOffset: 100_000 })).toThrow('satOffset 100000 is outside the 100000-sat funding input');
  });

  it('a batch takes satOffset only in same-sat mode, as ord takes sat / satpoint only there', async () => {
    const { createBatchInscribeTransactions } = await import('./inscription-batch.helper');
    const args = {
      inscriptions: [{ body: new TextEncoder().encode('x'), contentType: 'text/plain' }],
      recipientAddress: paymentAddress,
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
      paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
      paymentAddress,
      feeRatePerVbyte: 3,
      network: NETWORK,
      satOffset: 5_000,
    };
    expect(() => createBatchInscribeTransactions({ ...args, mode: 'separate-outputs' }))
      .toThrow('`satOffset` can only be set in `same-sat` mode');
    const r = createBatchInscribeTransactions({ ...args, mode: 'same-sat' });
    expect(outputs(r.commitPsbt)[0][1]).toBe(5_000);
  });
});
