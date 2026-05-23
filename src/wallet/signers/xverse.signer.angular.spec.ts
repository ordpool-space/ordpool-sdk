import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, lastValueFrom, of } from 'rxjs';
import { BitcoinNetworkType, SignTransactionOptions, SignTransactionResponse } from 'sats-connect';

import { Network } from '../../network';

// sats-connect's `signTransaction` is imported at module top, mock
// before the signer-under-test is imported so the mock binding is
// in place.
jest.mock('sats-connect', () => {
  const actual = jest.requireActual('sats-connect') as Record<string, unknown>;
  return {
    ...actual,
    signTransaction: jest.fn(),
  };
});
import { signTransaction } from 'sats-connect';

import { xverseSigner } from './xverse.signer';


describe('xverseSigner.signAndBroadcast', () => {

  const signTransactionMock = signTransaction as unknown as jest.Mock;

  beforeEach(() => {
    signTransactionMock.mockReset();
  });

  it('when called, hits sats-connect.signTransaction with broadcast=true, base64(unsigned), Mainnet network, the payment address as inputsToSign, and SIGHASH_ALL', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ txId: 'txid-from-sats-connect' } as SignTransactionResponse);
    }) as never);

    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0xab]);

    const result = await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      // If our adapter accidentally routed through the broadcast
      // callback, the result.txId assertion below catches it.
      broadcast: () => of('LEAKED-FROM-BROADCAST-CALLBACK'),
    }));

    expect(signTransactionMock).toHaveBeenCalledTimes(1);
    const args = signTransactionMock.mock.calls[0][0] as SignTransactionOptions;
    expect(args.payload.psbtBase64).toBe(base64.encode(unsignedBytes));
    expect(args.payload.broadcast).toBe(true);
    expect(args.payload.network.type).toBe(BitcoinNetworkType.Mainnet);
    // sats-connect v4 typed inputsToSign as optional; assert
    // it's defined first so the per-element accesses don't trip
    // strict-null-checks.
    expect(args.payload.inputsToSign).toBeDefined();
    expect(args.payload.inputsToSign![0].address).toBe('bc1qpayment');
    expect(args.payload.inputsToSign![0].signingIndexes).toEqual([0]);
    expect(args.payload.inputsToSign![0].sigHash).toBe(btc.SigHash.ALL);
    expect(result).toEqual({ txId: 'txid-from-sats-connect' });
  });

  it('when network is Testnet4, maps to the literal "Testnet4" string (Xverse v2 mode-equality check rejects bare "Testnet")', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ txId: 'tx' } as SignTransactionResponse);
    }) as never);

    await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'tb1qpayment',
      network: Network.Testnet4,
      broadcast: () => of('unused'),
    }));

    const args = signTransactionMock.mock.calls[0][0] as SignTransactionOptions;
    expect(args.payload.network.type).toBe('Testnet4');
  });

  it('when sats-connect onFinish returns a response without a txId, the adapter emits an empty string (current behaviour, soft-fail)', async () => {
    // Behaviour-locking test: today the signer falls through to ''
    // rather than treating a missing txId as an error. If we ever
    // decide a missing txId should error, this spec changes.
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({} as SignTransactionResponse);
    }) as never);

    const result = await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    }));

    expect(result).toEqual({ txId: '' });
  });

  it('when sats-connect calls onCancel, the adapter throws an error to the caller', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onCancel();
    }) as never);

    const result$ = xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    });

    await expect(lastValueFrom(result$)).rejects.toThrow('Request was cancelled');
  });
});
