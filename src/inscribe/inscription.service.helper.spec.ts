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

  describe('optional reveal-tx tip output', () => {
    const TIP_PRIV = new Uint8Array(32).fill(0x7e);
    const tipAddress = () => btc.p2tr(schnorr.getPublicKey(TIP_PRIV), undefined, scureNetwork, true).address!;

    it('no tip → reveal has exactly one output, commit output sized to postage + revealFee', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('no tip baseline'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        network: NETWORK,
      });
      const revealTx = btc.Transaction.fromRaw(hex.decode(result.revealHex));
      expect(revealTx.outputsLength).toBe(1);
      expect(result.commit.outputValueSats).toBe(546 + result.fees.revealFeeSats);
    });

    it('with tip → reveal has 2 outputs, tip at vout[1] with exact tip sats, commit output grows by tip.value', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const TIP_SATS = 5_000;
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('tipped inscription'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        tip: { address: tipAddress(), value: TIP_SATS },
        network: NETWORK,
      });
      const revealTx = btc.Transaction.fromRaw(hex.decode(result.revealHex));
      expect(revealTx.outputsLength).toBe(2);
      expect(revealTx.getOutput(0).amount).toBe(BigInt(546));
      expect(revealTx.getOutput(1).amount).toBe(BigInt(TIP_SATS));
      expect(result.commit.outputValueSats).toBe(546 + result.fees.revealFeeSats + TIP_SATS);
    });

    it('reveal vout[0] is the recipient and vout[1] is the tip address (ord first-sat rule preserved)', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const recipient = recipientAddress();
      const tipAddr = tipAddress();
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipient,
        body: new TextEncoder().encode('vout ordering'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        tip: { address: tipAddr, value: 1234 },
        network: NETWORK,
      });
      const revealTx = btc.Transaction.fromRaw(hex.decode(result.revealHex));
      const out0Script = revealTx.getOutput(0).script!;
      const out1Script = revealTx.getOutput(1).script!;
      const recipientScript = btc.OutScript.encode(btc.Address(scureNetwork).decode(recipient));
      const tipScript = btc.OutScript.encode(btc.Address(scureNetwork).decode(tipAddr));
      expect(Buffer.from(out0Script).equals(Buffer.from(recipientScript))).toBe(true);
      expect(Buffer.from(out1Script).equals(Buffer.from(tipScript))).toBe(true);
    });

    it('tip.value = 0 → no tip output is appended (zero is the skip sentinel)', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('zero tip'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        tip: { address: tipAddress(), value: 0 },
        network: NETWORK,
      });
      const revealTx = btc.Transaction.fromRaw(hex.decode(result.revealHex));
      expect(revealTx.outputsLength).toBe(1);
      expect(result.commit.outputValueSats).toBe(546 + result.fees.revealFeeSats);
    });

    it('rejects a non-integer tip.value', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      expect(() => createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('bad tip'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        tip: { address: tipAddress(), value: 1.5 },
        network: NETWORK,
      })).toThrow(/integer/);
    });

    it('rejects a negative tip.value', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      expect(() => createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('bad tip'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        tip: { address: tipAddress(), value: -1 },
        network: NETWORK,
      })).toThrow(/non-negative/);
    });
  });

  describe('nLockTime=21 free-cat behaviour', () => {
    it('commit PSBT always carries lockTime=21 (free cat for every inscriber)', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('free cat'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        network: NETWORK,
      });
      const commitTx = btc.Transaction.fromPSBT(result.commitPsbt);
      expect(commitTx.lockTime).toBe(21);
    });

    it('reveal tx also carries lockTime=21 (the SECOND cat — there are never enough)', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('second cat too'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        network: NETWORK,
      });
      const revealTx = btc.Transaction.fromRaw(hex.decode(result.revealHex));
      expect(revealTx.lockTime).toBe(21);
    });

    it('non-cat21wallet sets sequence = 0xfffffffe on the funding input (RBF disabled)', async () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const { KnownOrdinalWalletType } = await import('../wallet/wallet.service.types');
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('xverse seq'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        walletType: KnownOrdinalWalletType.xverse,
        network: NETWORK,
      });
      const commitTx = btc.Transaction.fromPSBT(result.commitPsbt);
      expect(commitTx.getInput(0).sequence).toBe(0xfffffffe);
    });

    it('cat21wallet sets sequence = 0xfffffffd on the funding input (RBF allowed, our wallet preserves lockTime=21)', async () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const { KnownOrdinalWalletType } = await import('../wallet/wallet.service.types');
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('cat21wallet seq'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        walletType: KnownOrdinalWalletType.cat21wallet,
        network: NETWORK,
      });
      const commitTx = btc.Transaction.fromPSBT(result.commitPsbt);
      expect(commitTx.getInput(0).sequence).toBe(0xfffffffd);
    });

    it('default walletType (omitted) falls through to the non-RBF sequence', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('default seq'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        network: NETWORK,
      });
      const commitTx = btc.Transaction.fromPSBT(result.commitPsbt);
      expect(commitTx.getInput(0).sequence).toBe(0xfffffffe);
    });
  });

  describe('optional note tag (0x0f)', () => {
    it('note → envelope carries tag 0x0f with UTF-8 bytes of the note', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('with note'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        note: 'minted via ordpool.space',
        network: NETWORK,
      });
      // The envelope script bytes contain the note value. Tag 0x0f
      // encodes as opcode OP_15 (0x5f) and the UTF-8 push follows.
      const envelopeHex = Array.from(result.commit.envelopeScript)
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const noteHex = Array.from(new TextEncoder().encode('minted via ordpool.space'))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      expect(envelopeHex).toContain(noteHex);
      // OP_15 = 0x5f, immediately preceding the note push prefix.
      expect(envelopeHex).toMatch(/5f[0-9a-f]{2}[0-9a-f]*/);
    });
  });

  describe('optional parent inscription id (0x03)', () => {
    it('parent → envelope carries tag 0x03 (OP_3) with the reversed-txid encoding', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const PARENT_ID = 'aa000000000000000000000000000000000000000000000000000000000000bbi0';
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('with parent'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        parent: PARENT_ID,
        network: NETWORK,
      });
      const envelopeHex = Array.from(result.commit.envelopeScript)
        .map(b => b.toString(16).padStart(2, '0')).join('');
      // OP_3 = 0x53, followed by a 32-byte push (0x20). Then bb00...aa
      // (reversed txid — proves the byte-order flip landed).
      const reversedTxidHex = 'bb' + '00'.repeat(30) + 'aa';
      expect(envelopeHex).toContain('5320' + reversedTxidHex);
    });

    it('rejects a malformed parent id', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      expect(() => createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new TextEncoder().encode('bad parent'),
        contentType: 'text/plain',
        feeRatePerVbyte: 8,
        parent: 'not-a-valid-id',
        network: NETWORK,
      })).toThrow(/Invalid inscription id/);
    });
  });

  describe('optional contentEncoding hint', () => {
    it('contentEncoding=br → envelope carries tag 0x09 (OP_9) with UTF-8 "br"', () => {
      const { paymentPublicKey, paymentAddress } = paymentContext();
      const result = createInscribeTransactions({
        paymentOutput: paymentOutputAt(100_000),
        paymentPublicKey,
        paymentAddress,
        recipientAddress: recipientAddress(),
        body: new Uint8Array([0x1f, 0x8b]),
        contentType: 'text/html',
        feeRatePerVbyte: 8,
        contentEncoding: 'br',
        network: NETWORK,
      });
      const envelopeHex = Array.from(result.commit.envelopeScript)
        .map(b => b.toString(16).padStart(2, '0')).join('');
      // OP_9 = 0x59 followed by a 2-byte push (0x02) of UTF-8 "br" = 0x62 0x72.
      expect(envelopeHex).toContain('5902' + '6272');
    });
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
