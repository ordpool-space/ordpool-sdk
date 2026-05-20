import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, lastValueFrom } from 'rxjs';
import { BitcoinNetworkType, SignTransactionOptions, SignTransactionResponse } from 'sats-connect';

import { Network } from '../../network';

// sats-connect's `signTransaction` is imported at module top — mock
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

  it('calls sats-connect.signTransaction with broadcast:true and the PSBT as base64', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ txId: 'returned-txid' } as SignTransactionResponse);
    }) as never);

    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0xab]);

    const result = await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => { throw new Error('NEVER CALLED — Xverse broadcasts itself'); },
    }));

    expect(signTransactionMock).toHaveBeenCalledTimes(1);
    const args = signTransactionMock.mock.calls[0][0] as SignTransactionOptions;
    expect(args.payload.psbtBase64).toBe(base64.encode(unsignedBytes));
    expect(args.payload.broadcast).toBe(true);
    expect(args.payload.network.type).toBe(BitcoinNetworkType.Mainnet);
    expect(args.payload.inputsToSign[0].address).toBe('bc1qpayment');
    expect(args.payload.inputsToSign[0].signingIndexes).toEqual([0]);
    expect(args.payload.inputsToSign[0].sigHash).toBe(btc.SigHash.ALL);
    expect(result).toEqual({ txId: 'returned-txid' });
  });

  it('maps Network.Testnet4 to BitcoinNetworkType.Testnet for sats-connect', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ txId: 'tx' } as SignTransactionResponse);
    }) as never);

    await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'tb1qpayment',
      network: Network.Testnet4,
      broadcast: () => { throw new Error('unused'); },
    }));

    const args = signTransactionMock.mock.calls[0][0] as SignTransactionOptions;
    expect(args.payload.network.type).toBe(BitcoinNetworkType.Testnet);
  });

  it('ignores the broadcast callback — Xverse broadcasts via sats-connect itself', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ txId: 'xverse-tx' } as SignTransactionResponse);
    }) as never);

    const broadcast = jest.fn();
    await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcast as never,
    }));

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('ignores promptForSignedPsbt — Xverse signs in its own UI', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ txId: 'tx' } as SignTransactionResponse);
    }) as never);

    const promptForSignedPsbt = jest.fn();
    await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => { throw new Error('unused'); },
      promptForSignedPsbt: promptForSignedPsbt as never,
    }));

    expect(promptForSignedPsbt).not.toHaveBeenCalled();
  });

  it('works the same way when promptForSignedPsbt is absent', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ txId: 'tx' } as SignTransactionResponse);
    }) as never);

    const result = await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => { throw new Error('unused'); },
    }));

    expect(result).toEqual({ txId: 'tx' });
  });

  it('emits empty txId when sats-connect returns a response without one (current behaviour, soft-fail)', async () => {
    // Today the signer falls through to `''` rather than treating
    // a missing txId as an error. Behaviour-locking test — if we
    // ever decide a missing txId should error, this spec changes.
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({} as SignTransactionResponse);
    }) as never);

    const result = await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => { throw new Error('unused'); },
    }));

    expect(result).toEqual({ txId: '' });
  });

  it('propagates the user-cancel as a thrown error', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onCancel();
    }) as never);

    const result$ = xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => { throw new Error('unused'); },
    });

    await expect(lastValueFrom(result$)).rejects.toThrow('Request was cancelled');
  });
});
