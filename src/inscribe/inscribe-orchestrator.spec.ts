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

import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

import { inscribeAndBroadcast } from './inscribe-orchestrator';

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
