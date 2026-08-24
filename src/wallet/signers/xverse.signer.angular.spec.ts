import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { base64 } from '@scure/base';
import { firstValueFrom, lastValueFrom, of } from 'rxjs';

import { Network } from '../../network';

// Mocks must be in place BEFORE the signer-under-test is imported.
// Xverse now signs via the modern `Wallet.request('signPsbt', ...)` RPC;
// mock the default export's `request` (and the named `request`, sharing
// the same fn) so `Wallet.request` in the signer resolves to it.
jest.mock('sats-connect', () => {
  const actual = jest.requireActual('sats-connect') as Record<string, unknown>;
  const requestMock = jest.fn();
  return {
    __esModule: true,
    ...actual,
    request: requestMock,
    default: { ...((actual.default as object) ?? {}), request: requestMock },
  };
});
jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
import Wallet from 'sats-connect';
import { broadcastSignedPsbt } from '../psbt-extract';

import { xverseSigner } from './xverse.signer';


describe('xverseSigner — sats-connect signPsbt (modern RPC API)', () => {

  const requestMock = (Wallet as unknown as { request: jest.Mock }).request;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

  const ok = (psbt: string) => Promise.resolve({ status: 'success', result: { psbt } });

  beforeEach(() => {
    requestMock.mockReset();
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  it('signSingleFundingInput: requests signPsbt for input 0 at the payment address WITHOUT broadcasting, then extracts + broadcasts via the callback', async () => {
    requestMock.mockReturnValue(ok('cHNidP8B'));

    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0xab]);
    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: jest.fn((_h: string) => of('UNUSED')) as never,
    };
    const result = await firstValueFrom(xverseSigner.signSingleFundingInput(input));

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [method, params] = requestMock.mock.calls[0] as [string, { psbt: string; signInputs: Record<string, number[]>; broadcast: boolean }];
    expect(method).toBe('signPsbt');
    expect(params.psbt).toBe(base64.encode(unsignedBytes));
    // WE-broadcast convention: ask for sign-only.
    expect(params.broadcast).toBe(false);
    expect(params.signInputs).toEqual({ 'bc1qpayment': [0] });

    // Signer hands the decoded signed PSBT to the shared broadcast helper.
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, base64.decode('cHNidP8B'));
    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('multi-input: signInputs lists ONLY the wallet\'s own indexes, so a foreign input (e.g. the child-reveal ephemeral commit) is left unsigned', async () => {
    requestMock.mockReturnValue(ok('cHNidP8B'));

    // signOfferAccept is a public op-named method that signs ONLY input 0
    // at the ordinals address (the seller's cat / the child reveal's
    // parent-input topology). The PSBT's other input(s) — e.g. index 1,
    // the ephemeral commit or a buyer's pre-signed input — are absent from
    // signInputs, so Xverse signs input 0 and leaves the rest.
    await firstValueFrom(xverseSigner.signOfferAccept({
      psbtBytes: new Uint8Array(8),
      ordinalsAddress: 'bc1pordinals',
      network: Network.Mainnet,
      broadcast: () => of('tx'),
    }));

    const [method, params] = requestMock.mock.calls[0] as [string, { signInputs: Record<string, number[]>; broadcast: boolean }];
    expect(method).toBe('signPsbt');
    expect(params.signInputs).toEqual({ 'bc1pordinals': [0] });
    expect(params.broadcast).toBe(false);
  });

  it('when signPsbt returns status "error", the adapter throws with the wallet message + code', async () => {
    requestMock.mockReturnValue(Promise.resolve({ status: 'error', error: { message: 'User rejected the request', code: 4001 } }));

    const result$ = xverseSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    });

    await expect(lastValueFrom(result$)).rejects.toThrow(/Xverse signPsbt failed: User rejected the request \(code 4001\)/);
  });

  it('when broadcastSignedPsbt errors (e.g. mempool rejected), the adapter propagates the error', async () => {
    requestMock.mockReturnValue(ok('cHNidP8B'));
    broadcastSignedPsbtMock.mockImplementation(() => {
      throw new Error('mempool full');
    });

    const result$ = xverseSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(lastValueFrom(result$)).rejects.toThrow('mempool full');
  });
});
