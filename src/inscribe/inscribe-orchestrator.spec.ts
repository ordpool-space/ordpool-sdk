/**
 * `inscribeAndBroadcast` orchestrator spec.
 *
 * Exercises the public surface: build commit + reveal, sign commit
 * via the operation-named signer method, broadcast both, return the
 * ephemeral key + txids. Uses a stub wallet signer plugged into the
 * registry via `KnownOrdinalWalletType.xpub` (the watch-only signer)
 * to avoid needing a browser-extension API surface in node-jest.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of } from 'rxjs';

import { InscriptionParserService } from 'ordpool-parser';

import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

import { encodeCborDeterministic } from './inscription-cbor';
import { inscribeAndBroadcast, inscribeBatchAndBroadcast } from './inscribe-orchestrator';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);

const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);

function paymentContext() {
  const paymentPublicKey = secp256k1.getPublicKey(PAYMENT_PRIV, true);
  const p2tr = btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true);
  return {
    paymentPublicKey,
    paymentAddress: p2tr.address!,
  };
}

function recipientAddress() {
  const k = new Uint8Array(32).fill(0xcd);
  return btc.p2tr(schnorr.getPublicKey(k), undefined, scureNetwork, true).address!;
}

function paymentOutputAt(valueSats: number) {
  return {
    txid: 'd'.repeat(64),
    vout: 0,
    value: valueSats,
    status: { confirmed: true },
  };
}

describe('inscribeAndBroadcast orchestrator', () => {

  it('produces the full {commitTxId, revealTxId, ephemeral, fees, commitAddress} on the happy path via watch-only signer', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const body = new TextEncoder().encode('orchestrator end-to-end');

    // The watch-only (xpub) signer routes through promptForSignedPsbt
    // for the wallet sign step. The fake here mimics a Sparrow user
    // pasting the signed PSBT back: we receive the unsigned commit,
    // "sign" it by dummy-keying the funding input via the same
    // private key the payment context used, return base64.
    const promptForSignedPsbt = (unsigned: { base64: string; hex: string }) => {
      const psbt = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
      psbt.signIdx(PAYMENT_PRIV, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      psbt.finalize();
      // The watch-only signer reads the signed PSBT (with finalScriptWitness)
      // and extracts the wire-tx-hex via `tx.hex`. We return the signed PSBT
      // bytes (with the witness baked in) so the signer's path works.
      return of(base64.encode(psbt.toPSBT(0)));
    };

    const broadcasts: string[] = [];
    const broadcast = jest.fn((txHex: string) => {
      broadcasts.push(txHex);
      const id = btc.Transaction.fromRaw(hex.decode(txHex)).id;
      return of(id);
    });

    let capturedSignedCommit: string | undefined;
    const result = await firstValueFrom(inscribeAndBroadcast({
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body,
      contentType: 'text/plain',
      feeRatePerVbyte: 5,
      network: NETWORK,
      broadcast,
      promptForSignedPsbt,
      onCommitSigned: (hex) => { capturedSignedCommit = hex; },
    }));

    expect(result.commitTxId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.revealTxId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.commitAddress.startsWith('bc1p')).toBe(true);
    expect(result.ephemeral.privKey.length).toBe(32);
    expect(result.ephemeral.pubkeyXonly.length).toBe(32);
    expect(result.fees.totalFeeSats).toBeGreaterThan(0);

    // Two broadcasts in order: commit, then reveal.
    expect(broadcasts.length).toBe(2);
    expect(broadcasts[0]).toBe(capturedSignedCommit);

    // The orchestrator's commitTxId must equal the txid of the
    // signed commit hex it broadcast.
    const commitTx = btc.Transaction.fromRaw(hex.decode(broadcasts[0]));
    expect(commitTx.id).toBe(result.commitTxId);

    // The orchestrator's revealTxId must equal the txid of the
    // reveal hex it broadcast.
    const revealTx = btc.Transaction.fromRaw(hex.decode(broadcasts[1]));
    expect(revealTx.id).toBe(result.revealTxId);
  });

  it('threads pointer + metaprotocol + delegate + rune + metadata + note through to the broadcast reveal', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const DELEGATE_ID = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
    const metadata = encodeCborDeterministic({ author: 'ordpool' });

    const promptForSignedPsbt = (unsigned: { base64: string; hex: string }) => {
      const psbt = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
      psbt.signIdx(PAYMENT_PRIV, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      psbt.finalize();
      return of(base64.encode(psbt.toPSBT(0)));
    };

    const broadcasts: string[] = [];
    const broadcast = jest.fn((txHex: string) => {
      broadcasts.push(txHex);
      return of(btc.Transaction.fromRaw(hex.decode(txHex)).id);
    });

    const result = await firstValueFrom(inscribeAndBroadcast({
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      // delegate inscriptions carry an empty body.
      body: new Uint8Array(0),
      feeRatePerVbyte: 5,
      pointer: 200,
      metaprotocol: 'brc-20',
      delegate: DELEGATE_ID,
      rune: 258n,
      metadata,
      note: 'ordpool.space',
      network: NETWORK,
      broadcast,
      promptForSignedPsbt,
    }));

    // broadcasts[1] is the reveal — parse its witness the way an indexer would.
    const revealTx = btc.Transaction.fromRaw(hex.decode(broadcasts[1]));
    expect(revealTx.id).toBe(result.revealTxId);
    const witness = revealTx.getInput(0).finalScriptWitness!.map(w => hex.encode(w));
    const parsed = InscriptionParserService.parse({ txid: result.revealTxId, vin: [{ witness }] });
    expect(parsed.length).toBe(1);
    expect(parsed[0].getPointer()).toBe(200);
    expect(parsed[0].getMetaprotocol()).toBe('brc-20');
    expect(parsed[0].getDelegates()).toEqual([DELEGATE_ID]);
    expect(parsed[0].getRune()).toEqual(new Uint8Array([0x02, 0x01]));
    expect(parsed[0].getMetadata()).toEqual({ author: 'ordpool' });
    expect(parsed[0].getNote()).toBe('ordpool.space');
  });

  it('throws "Insufficient funds for inscribe" when funding < requirement (no signer call)', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();

    const broadcast = jest.fn(() => of('0'.repeat(64)));
    const promptForSignedPsbt = jest.fn(() => of(''));

    await expect(firstValueFrom(inscribeAndBroadcast({
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: paymentOutputAt(500), // way too small
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('too poor'),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      network: NETWORK,
      broadcast,
      promptForSignedPsbt,
    }))).rejects.toThrow(/Insufficient funds for inscribe/);

    expect(broadcast).not.toHaveBeenCalled();
    expect(promptForSignedPsbt).not.toHaveBeenCalled();
  });

  it('rejects unknown walletType with a clear error from findSignerOrThrow', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();

    await expect(firstValueFrom(inscribeAndBroadcast({
      walletType: 'not-a-wallet' as unknown as KnownOrdinalWalletType,
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('unknown wallet'),
      contentType: 'text/plain',
      feeRatePerVbyte: 5,
      network: NETWORK,
      broadcast: () => of('0'.repeat(64)),
    }))).rejects.toThrow(/No signer registered/);
  });
});

describe('inscribeBatchAndBroadcast orchestrator', () => {
  it('signs the one commit input, broadcasts commit then a reveal that spends it and carries every inscription', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const promptForSignedPsbt = (unsigned: { base64: string; hex: string }) => {
      const psbt = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
      psbt.signIdx(PAYMENT_PRIV, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      psbt.finalize();
      return of(base64.encode(psbt.toPSBT(0)));
    };
    const broadcasts: string[] = [];
    const broadcast = jest.fn((txHex: string) => {
      broadcasts.push(txHex);
      return of(btc.Transaction.fromRaw(hex.decode(txHex)).id);
    });
    const bodies = ['first', 'second'].map(s => new TextEncoder().encode(s));

    const result = await firstValueFrom(inscribeBatchAndBroadcast({
      mode: 'separate-outputs',
      inscriptions: bodies.map(body => ({ body, contentType: 'text/plain' })),
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      feeRatePerVbyte: 5,
      network: NETWORK,
      broadcast,
      promptForSignedPsbt,
    }));

    expect(broadcasts.length).toBe(2);
    const commitTx = btc.Transaction.fromRaw(hex.decode(broadcasts[0]));
    const revealTx = btc.Transaction.fromRaw(hex.decode(broadcasts[1]));
    expect(commitTx.id).toBe(result.commitTxId);
    expect(revealTx.id).toBe(result.revealTxId);
    // The pre-built reveal spends the commit the wallet actually signed.
    expect(hex.encode(revealTx.getInput(0).txid!)).toBe(result.commitTxId);
    expect(revealTx.getInput(0).index).toBe(0);

    expect(result.inscriptions.map(l => l.vout)).toEqual([0, 1]);
    const witness = revealTx.getInput(0).finalScriptWitness!.map(w => hex.encode(w));
    const parsed = InscriptionParserService.parse({ txid: revealTx.id, vin: [{ witness }] });
    expect(parsed.map(p => new TextDecoder().decode(p.getDataRaw()))).toEqual(['first', 'second']);
  });
});

describe('inscribeBatchAndBroadcast with parents', () => {
  const OWNER_PRIV = new Uint8Array(32).fill(0xef);
  const parentAt = (n: number, value: number, ownerKey = OWNER_PRIV) => {
    const p = btc.p2tr(schnorr.getPublicKey(ownerKey), undefined, scureNetwork, true);
    return {
      id: `${String(n).repeat(64)}i0`,
      utxo: { txid: String(n).repeat(64), vout: 0, value, scriptPubKey: p.script, tapInternalKey: schnorr.getPublicKey(ownerKey) },
      returnAddress: p.address!,
    };
  };

  it('signs the commit, then has the wallet sign every parent input, and broadcasts a reveal spending them all', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    // The watch-only signer hands each PSBT to the user; this stands in for
    // the wallet: the commit gets the payment key, the reveal's parent
    // inputs the owner key.
    const promptForSignedPsbt = (unsigned: { base64: string; hex: string }) => {
      const psbt = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
      if (psbt.inputsLength === 1) {
        psbt.signIdx(PAYMENT_PRIV, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
        psbt.finalize();
      } else {
        for (let i = 0; i < psbt.inputsLength - 1; i++) psbt.signIdx(OWNER_PRIV, i);
      }
      return of(base64.encode(psbt.toPSBT(0)));
    };
    const broadcasts: string[] = [];
    const broadcast = jest.fn((txHex: string) => {
      broadcasts.push(txHex);
      return of(btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownInputs: true }).id);
    });

    const result = await firstValueFrom(inscribeBatchAndBroadcast({
      mode: 'shared-output',
      inscriptions: [{ body: new TextEncoder().encode('a'), contentType: 'text/plain' },
        { body: new TextEncoder().encode('b'), contentType: 'text/plain' }],
      parents: [parentAt(1, 546), parentAt(2, 2000)],
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      feeRatePerVbyte: 5,
      network: NETWORK,
      broadcast,
      promptForSignedPsbt,
    }));

    expect(broadcasts.length).toBe(2);
    const reveal = btc.Transaction.fromRaw(hex.decode(broadcasts[1]), { allowUnknownInputs: true });
    expect(reveal.id).toBe(result.revealTxId);
    expect(hex.encode(reveal.getInput(2).txid!)).toBe(result.commitTxId);
    expect([0, 1, 2].map(i => reveal.getInput(i).finalScriptWitness!.length)).toEqual([1, 1, 3]);
    expect(result.inscriptions.map(l => [l.vout, l.offset])).toEqual([[2, 0], [2, 546]]);
  });

  it('a satpoints batch without parents: the wallet signs the satpoint inputs, and each output carries its UTXO', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const promptForSignedPsbt = (unsigned: { base64: string; hex: string }) => {
      const psbt = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
      if (psbt.inputsLength === 1) {
        psbt.signIdx(PAYMENT_PRIV, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
        psbt.finalize();
      } else {
        for (let i = 0; i < psbt.inputsLength - 1; i++) psbt.signIdx(OWNER_PRIV, i);
      }
      return of(base64.encode(psbt.toPSBT(0)));
    };
    const broadcasts: string[] = [];
    const broadcast = jest.fn((txHex: string) => {
      broadcasts.push(txHex);
      return of(btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownInputs: true }).id);
    });
    const utxoOf = (n: number, value: number) => ({ ...parentAt(n, value).utxo });

    const result = await firstValueFrom(inscribeBatchAndBroadcast({
      mode: 'satpoints',
      inscriptions: [
        { body: new TextEncoder().encode('a'), contentType: 'text/plain', satpoint: utxoOf(5, 4_000) },
        { body: new TextEncoder().encode('b'), contentType: 'text/plain', satpoint: utxoOf(6, 6_000) },
      ],
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      feeRatePerVbyte: 5,
      network: NETWORK,
      broadcast,
      promptForSignedPsbt,
    }));

    const reveal = btc.Transaction.fromRaw(hex.decode(broadcasts[1]), { allowUnknownInputs: true });
    expect(reveal.id).toBe(result.revealTxId);
    expect(hex.encode(reveal.getInput(2).txid!)).toBe(result.commitTxId);
    expect([0, 1, 2].map(i => reveal.getInput(i).finalScriptWitness!.length)).toEqual([1, 1, 3]);
    expect([0, 1].map(i => Number(reveal.getOutput(i).amount))).toEqual([4_000, 6_000]);
  });

  it('refuses parents held by different owners, since the wallet signs them at one address', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    await expect(firstValueFrom(inscribeBatchAndBroadcast({
      mode: 'separate-outputs',
      inscriptions: [{ body: new TextEncoder().encode('a'), contentType: 'text/plain' }],
      parents: [parentAt(1, 546), parentAt(2, 546, new Uint8Array(32).fill(0x12))],
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: paymentOutputAt(100_000),
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      feeRatePerVbyte: 5,
      network: NETWORK,
      broadcast: () => of('x'),
    }))).rejects.toThrow('every parent and satpoint UTXO must sit at the same ordinals address');
  });
});
