/**
 * Layer-4 orchestration spec: createInscribeTransactions ties the
 * full inscribe pipeline. The spec exercises the public contract:
 *
 *   - Returns { commitPsbt, revealHex, revealTxid, commitAddress,
 *     fees } shape.
 *   - Reveal txid is consistent with the revealHex.
 *   - Commit PSBT decodes to a valid scure Transaction.
 *   - The ephemeral key is destroyed (no way to test directly —
 *     the function doesn't return it).
 *   - Insufficient funds throws with a clear message.
 *
 * Round-trip against ordpool-parser already lives in
 * `inscription-commit-reveal.spec.ts`; here we focus on the
 * orchestrator's wire-up.
 */

import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { InscriptionParserService } from 'ordpool-parser';

import { Network, toScureNetwork } from '../network';

import { createInscribeTransactions } from './inscription.service.helper';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);

const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const RECIPIENT_PRIV = new Uint8Array(32).fill(0xcd);

function paymentContext() {
  const paymentPublicKey = secp256k1.getPublicKey(PAYMENT_PRIV, true);
  const p2tr = btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true);
  return {
    paymentPublicKey,
    paymentPubkeyXonly: schnorr.getPublicKey(PAYMENT_PRIV),
    paymentAddress: p2tr.address!,
  };
}

function recipientAddress() {
  return btc.p2tr(schnorr.getPublicKey(RECIPIENT_PRIV), undefined, scureNetwork, true).address!;
}

function paymentOutputAt(valueSats: number) {
  return {
    txid: 'd'.repeat(64),
    vout: 0,
    value: valueSats,
    status: { confirmed: true },
  };
}


describe('createInscribeTransactions', () => {

  it('returns the full {commitPsbt, revealHex, revealTxid, commitAddress, fees} shape', () => {
    const { paymentPublicKey, paymentPubkeyXonly, paymentAddress } = paymentContext();
    const result = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      paymentPubkeyXonly,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('hello orchestrator'),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      network: NETWORK,
    });

    expect(result.commitPsbt.length).toBeGreaterThan(0);
    expect(result.revealHex.length).toBeGreaterThan(0);
    expect(result.revealTxid.length).toBe(64);
    expect(result.commitAddress.startsWith('bc1p')).toBe(true);
    expect(result.fees.totalFeeSats).toBeGreaterThan(0);
  });

  it('reveal txid matches the computed id of the decoded revealHex', () => {
    const { paymentPublicKey, paymentPubkeyXonly, paymentAddress } = paymentContext();
    const r = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      paymentPubkeyXonly,
      recipientAddress: recipientAddress(),
      body: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      contentType: 'application/octet-stream',
      feeRatePerVbyte: 5,
      network: NETWORK,
    });

    const decoded = btc.Transaction.fromRaw(hex.decode(r.revealHex));
    expect(decoded.id).toBe(r.revealTxid);
  });

  it('reveal references the commit txid (pre-signed) as its input 0 outpoint', () => {
    const { paymentPublicKey, paymentPubkeyXonly, paymentAddress } = paymentContext();
    const r = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      paymentPubkeyXonly,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('outpoint pin'),
      contentType: 'text/plain',
      feeRatePerVbyte: 10,
      network: NETWORK,
    });

    const commitTx = btc.Transaction.fromPSBT(r.commitPsbt);
    const decodedReveal = btc.Transaction.fromRaw(hex.decode(r.revealHex));

    expect(decodedReveal.getInput(0).index).toBe(0);
    // txid bytes in the reveal input's outpoint match commit tx's id.
    const revealInputTxid = decodedReveal.getInput(0).txid;
    expect(hex.encode(revealInputTxid!)).toBe(commitTx.id);
  });

  it('end-to-end: ordpool-parser reconstructs the original content from the broadcast reveal', () => {
    const { paymentPublicKey, paymentPubkeyXonly, paymentAddress } = paymentContext();
    const body = new TextEncoder().encode('through the whole pipeline');
    const r = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      paymentPubkeyXonly,
      recipientAddress: recipientAddress(),
      body,
      contentType: 'text/plain;charset=utf-8',
      feeRatePerVbyte: 7,
      network: NETWORK,
    });

    const decodedReveal = btc.Transaction.fromRaw(hex.decode(r.revealHex));
    const witness = decodedReveal.getInput(0).finalScriptWitness!.map(w => hex.encode(w));
    const fakeTx = { txid: r.revealTxid, vin: [{ witness }] };
    const parsed = InscriptionParserService.parse(fakeTx);
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBe('text/plain;charset=utf-8');
    expect(parsed[0].getDataRaw()).toEqual(body);
  });

  it('throws "Insufficient funds for inscribe" when funding < requirement', () => {
    const { paymentPublicKey, paymentPubkeyXonly, paymentAddress } = paymentContext();
    expect(() => createInscribeTransactions({
      paymentOutput: paymentOutputAt(500), // way too small
      paymentPublicKey,
      paymentAddress,
      paymentPubkeyXonly,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('too poor'),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      network: NETWORK,
    })).toThrow(/Insufficient funds for inscribe/);
  });

  it('rejects feeRatePerVbyte <= 0', () => {
    const { paymentPublicKey, paymentPubkeyXonly, paymentAddress } = paymentContext();
    expect(() => createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      paymentPubkeyXonly,
      recipientAddress: recipientAddress(),
      body: new Uint8Array(0),
      contentType: 'text/plain',
      feeRatePerVbyte: 0,
      network: NETWORK,
    })).toThrow(/positive/);
  });

  it('rejects 33-byte paymentPubkeyXonly', () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    expect(() => createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      paymentPubkeyXonly: new Uint8Array(33),
      recipientAddress: recipientAddress(),
      body: new Uint8Array(0),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      network: NETWORK,
    })).toThrow(/32 bytes/);
  });

  it('two consecutive calls produce DIFFERENT reveals (fresh ephemeral key each time)', () => {
    const { paymentPublicKey, paymentPubkeyXonly, paymentAddress } = paymentContext();
    const args = {
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      paymentPubkeyXonly,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('determinism check'),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      network: NETWORK,
    };
    const a = createInscribeTransactions(args);
    const b = createInscribeTransactions(args);
    // Different ephemeral keys → different commit addresses (envelope
    // embeds the ephemeral pubkey, which goes into the script tree).
    expect(a.commitAddress).not.toBe(b.commitAddress);
    expect(a.revealHex).not.toBe(b.revealHex);
  });
});
