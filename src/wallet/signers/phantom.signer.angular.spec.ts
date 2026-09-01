import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
import { broadcastSignedPsbt } from '../psbt-extract';

import { phantomSigner } from './phantom.signer';


/**
 * Pipeline A (mock-based) — pins OUR Phantom adapter's call shape
 * against a MOCKED `window.phantom.bitcoin`. These prove what
 * `phantom.signer.ts` passes to `signPSBT` (raw PSBT bytes, the
 * per-operation `inputsToSign` topology, the `finalize: false` flag)
 * and how it routes the signed PSBT to the shared broadcast helper.
 *
 * They do NOT prove the real Phantom binary signs anything — desktop
 * v26.x ships `btc.js` dormant, so `window.phantom.bitcoin` doesn't
 * exist there (see the signer docstring + `phantom-sdk-handshake
 * .spec.ts`). This is an ADAPTER contract test, not a wallet test.
 */
const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;


describe('phantomSigner.signSingleFundingInput (mint / inscribe-commit topology)', () => {

  let signPSBTMock: jest.Mock;

  beforeEach(() => {
    signPSBTMock = jest.fn();
    (window as unknown as { phantom: { bitcoin: { signPSBT: jest.Mock } } }).phantom = {
      bitcoin: { signPSBT: signPSBTMock },
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { phantom?: unknown }).phantom;
  });

  it('calls phantom.bitcoin.signPSBT(psbtBytes, {inputsToSign:[{paymentAddress, [0], SIGHASH_ALL}], finalize:false}) and hands the signed PSBT bytes to the shared broadcast helper', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    const signedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x99]);
    signPSBTMock.mockResolvedValue(signedBytes as never);

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    };
    const result = await firstValueFrom(phantomSigner.signSingleFundingInput(input));

    expect(signPSBTMock).toHaveBeenCalledTimes(1);
    // Phantom takes the RAW PSBT bytes (Uint8Array), not hex — unlike
    // the Unisat/OKX-family signers that pass a hex string.
    expect(signPSBTMock).toHaveBeenCalledWith(unsignedBytes, {
      inputsToSign: [{ address: 'bc1qpayment', signingIndexes: [0], sigHash: 0x01 }],
      finalize: false,
    });

    // Phantom returns a SIGNED PSBT (not a wire tx); the adapter routes
    // those bytes through broadcastSignedPsbt (the "WE broadcast" convention).
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, signedBytes);

    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when signPSBT rejects (user declined), propagates the error and never reaches the broadcast helper', async () => {
    signPSBTMock.mockRejectedValue(new Error('User rejected the request') as never);

    const result$ = phantomSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('User rejected the request');
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });

  it('when broadcastSignedPsbt errors (mempool rejected), the adapter propagates the error', async () => {
    signPSBTMock.mockResolvedValue(new Uint8Array([1, 2, 3]) as never);
    broadcastSignedPsbtMock.mockReturnValue(throwError(() => new Error('txn-mempool-conflict')));

    const result$ = phantomSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('txn-mempool-conflict');
  });

  it('when window.phantom is absent, throws synchronously reaching for .bitcoin (detect-by-signature never offers Phantom in that state)', () => {
    delete (window as unknown as { phantom?: unknown }).phantom;

    expect(() => phantomSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    })).toThrow(/bitcoin/);

    expect(signPSBTMock).toHaveBeenCalledTimes(0);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });
});


describe('phantomSigner.signTransfer (cat input 0 + funding inputs 1..N topology)', () => {

  let signPSBTMock: jest.Mock;

  beforeEach(() => {
    signPSBTMock = jest.fn();
    (window as unknown as { phantom: { bitcoin: { signPSBT: jest.Mock } } }).phantom = {
      bitcoin: { signPSBT: signPSBTMock },
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { phantom?: unknown }).phantom;
  });

  it('signs input 0 at ordinalsAddress + inputs 1..N at paymentAddress, all SIGHASH_ALL, finalize:false', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x02]);
    const signedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x03]);
    signPSBTMock.mockResolvedValue(signedBytes as never);

    const result = await firstValueFrom(phantomSigner.signTransfer({
      psbtBytes: unsignedBytes,
      ordinalsAddress: 'bc1pordinals',
      paymentAddress: 'bc1qpayment',
      fundingInputCount: 2,
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    }));

    expect(signPSBTMock).toHaveBeenCalledTimes(1);
    expect(signPSBTMock).toHaveBeenCalledWith(unsignedBytes, {
      inputsToSign: [
        { address: 'bc1pordinals', signingIndexes: [0], sigHash: btc.SigHash.ALL },
        { address: 'bc1qpayment', signingIndexes: [1, 2], sigHash: btc.SigHash.ALL },
      ],
      finalize: false,
    });

    // The signed PSBT bytes reach the broadcast helper unchanged.
    const [, passedSigned] = broadcastSignedPsbtMock.mock.calls[0] as [unknown, Uint8Array];
    expect(passedSigned).toBe(signedBytes);
    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });
});


describe('phantomSigner.signOfferAccept (seller signs ONLY input 0)', () => {

  let signPSBTMock: jest.Mock;

  beforeEach(() => {
    signPSBTMock = jest.fn();
    (window as unknown as { phantom: { bitcoin: { signPSBT: jest.Mock } } }).phantom = {
      bitcoin: { signPSBT: signPSBTMock },
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { phantom?: unknown }).phantom;
  });

  it('signs exactly input 0 at ordinalsAddress (SIGHASH_ALL) and touches no buyer input', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x06]);
    const signedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x07]);
    signPSBTMock.mockResolvedValue(signedBytes as never);

    const result = await firstValueFrom(phantomSigner.signOfferAccept({
      psbtBytes: unsignedBytes,
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: '02'.padEnd(66, '0'),
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    }));

    expect(signPSBTMock).toHaveBeenCalledTimes(1);
    expect(signPSBTMock).toHaveBeenCalledWith(unsignedBytes, {
      // ONLY index 0 — the buyer's funding inputs are pre-signed and
      // must not be re-touched by the seller.
      inputsToSign: [{ address: 'bc1pordinals', signingIndexes: [0], sigHash: btc.SigHash.ALL }],
      finalize: false,
    });
    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });
});


describe('phantomSigner.signOfferCreatePsbt (buyer signs funding inputs only, no broadcast)', () => {

  let signPSBTMock: jest.Mock;

  beforeEach(() => {
    signPSBTMock = jest.fn();
    (window as unknown as { phantom: { bitcoin: { signPSBT: jest.Mock } } }).phantom = {
      bitcoin: { signPSBT: signPSBTMock },
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { phantom?: unknown }).phantom;
  });

  it('signs ONLY buyer funding inputs 1..N at paymentAddress (never input 0) and returns the signed PSBT bytes directly', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x04]);
    const signedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x05]);
    signPSBTMock.mockResolvedValue(signedBytes as never);

    const result = await firstValueFrom(phantomSigner.signOfferCreatePsbt({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      fundingInputCount: 1,
      network: Network.Mainnet,
    }));

    expect(signPSBTMock).toHaveBeenCalledTimes(1);
    expect(signPSBTMock).toHaveBeenCalledWith(unsignedBytes, {
      inputsToSign: [{ address: 'bc1qpayment', signingIndexes: [1], sigHash: btc.SigHash.ALL }],
      finalize: false,
    });

    // Offer-create returns the raw partial-sig PSBT bytes (the buy-offer
    // artifact) BY REFERENCE — no broadcast helper is involved.
    expect(result).toBe(signedBytes);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });
});
