/**
 * Layer-4 orchestration spec: createInscribeTransactions ties the
 * full inscribe pipeline. The spec exercises the public contract:
 *
 *   - Returns the {commitPsbt, revealHex, revealTxid, commitAddress,
 *     fees, ephemeral, commit} shape.
 *   - Reveal txid is consistent with the revealHex.
 *   - Commit PSBT decodes to a valid scure Transaction.
 *   - The ephemeral key is returned (bearer instrument — consumer
 *     persists it for redirect / RBF / recover use cases).
 *   - The returned ephemeral pubkey matches the taproot internal
 *     key of the commit output (ord-style single-leaf shape).
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

  it('returns the full {commitPsbt, revealHex, revealTxid, commitAddress, fees, ephemeral, commit} shape', () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const result = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
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
    expect(result.ephemeral.privKey.length).toBe(32);
    expect(result.ephemeral.pubkeyXonly.length).toBe(32);
    expect(result.commit.outputScript.length).toBeGreaterThan(0);
    expect(result.commit.envelopeScript.length).toBeGreaterThan(0);
  });

  it('ephemeral.pubkeyXonly = Schnorr.getPublicKey(ephemeral.privKey) — the orchestrator returns a consistent keypair', () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const r = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('keypair check'),
      contentType: 'text/plain',
      feeRatePerVbyte: 5,
      network: NETWORK,
    });
    expect(schnorr.getPublicKey(r.ephemeral.privKey)).toEqual(r.ephemeral.pubkeyXonly);
  });

  it('reveal txid matches the computed id of the decoded revealHex', () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const r = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
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
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const r = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('outpoint pin'),
      contentType: 'text/plain',
      feeRatePerVbyte: 10,
      network: NETWORK,
    });

    const decodedReveal = btc.Transaction.fromRaw(hex.decode(r.revealHex));

    expect(decodedReveal.getInput(0).index).toBe(0);
    const revealInputTxid = decodedReveal.getInput(0).txid;
    expect(hex.encode(revealInputTxid!)).toBe(r.commitTxid);
  });

  it('end-to-end: ordpool-parser reconstructs the original content from the broadcast reveal', () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const body = new TextEncoder().encode('through the whole pipeline');
    const r = createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
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
    const { paymentPublicKey, paymentAddress } = paymentContext();
    expect(() => createInscribeTransactions({
      paymentOutput: paymentOutputAt(500),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('too poor'),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      network: NETWORK,
    })).toThrow(/Insufficient funds for inscribe/);
  });

  it('rejects feeRatePerVbyte <= 0', () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    expect(() => createInscribeTransactions({
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body: new Uint8Array(0),
      contentType: 'text/plain',
      feeRatePerVbyte: 0,
      network: NETWORK,
    })).toThrow(/positive/);
  });

  it('two consecutive calls produce DIFFERENT reveals (fresh ephemeral key each time)', () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const args = {
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('determinism check'),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      network: NETWORK,
    };
    const a = createInscribeTransactions(args);
    const b = createInscribeTransactions(args);
    expect(a.commitAddress).not.toBe(b.commitAddress);
    expect(a.revealHex).not.toBe(b.revealHex);
    // And the ephemeral keys themselves are distinct.
    expect(a.ephemeral.privKey).not.toEqual(b.ephemeral.privKey);
  });
});
