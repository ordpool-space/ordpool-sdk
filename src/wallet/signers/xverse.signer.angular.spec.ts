import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, lastValueFrom, of } from 'rxjs';
import { BitcoinNetworkType, SignTransactionOptions, SignTransactionResponse } from 'sats-connect';

import { Network } from '../../network';

// Mocks must be in place BEFORE the signer-under-test is imported.
jest.mock('sats-connect', () => {
  const actual = jest.requireActual('sats-connect') as Record<string, unknown>;
  return {
    ...actual,
    signTransaction: jest.fn(),
  };
});
jest.mock('../psbt-extract', () => ({
  extractWireTxFromPsbt: jest.fn(() => 'EXTRACTED_RAW_TX_HEX'),
}));
import { signTransaction } from 'sats-connect';
import { extractWireTxFromPsbt } from '../psbt-extract';

import { xverseSigner } from './xverse.signer';


describe('xverseSigner.signAndBroadcast', () => {

  const signTransactionMock = signTransaction as unknown as jest.Mock;
  const extractMock = extractWireTxFromPsbt as unknown as jest.Mock;

  beforeEach(() => {
    signTransactionMock.mockReset();
    extractMock.mockReset();
    extractMock.mockReturnValue('EXTRACTED_RAW_TX_HEX');
  });

  it('asks sats-connect to sign WITHOUT broadcasting, extracts the wire tx, and hands it to the caller\'s broadcast callback', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      // With broadcast:false Xverse returns the signed PSBT in
      // base64 instead of a txId.
      args.onFinish({ psbtBase64: 'cHNidP8B' } as SignTransactionResponse);
    }) as never);

    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0xab]);
    const broadcastMock = jest.fn((_rawTxHex: string) => of('TXID-FROM-BROADCAST-CALLBACK'));

    const result = await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    }));

    expect(signTransactionMock).toHaveBeenCalledTimes(1);
    const args = signTransactionMock.mock.calls[0][0] as SignTransactionOptions;
    expect(args.payload.psbtBase64).toBe(base64.encode(unsignedBytes));
    // WE-broadcast convention: ask for sign-only.
    expect(args.payload.broadcast).toBe(false);
    expect(args.payload.network.type).toBe(BitcoinNetworkType.Mainnet);
    expect(args.payload.inputsToSign).toBeDefined();
    expect(args.payload.inputsToSign![0].address).toBe('bc1qpayment');
    expect(args.payload.inputsToSign![0].signingIndexes).toEqual([0]);
    expect(args.payload.inputsToSign![0].sigHash).toBe(btc.SigHash.ALL);

    // Signer decodes the returned PSBT, extracts wire tx, and
    // hands it to the broadcast callback.
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(extractMock).toHaveBeenCalledWith(base64.decode('cHNidP8B'));
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith('EXTRACTED_RAW_TX_HEX');

    // Result.txId is whatever broadcast returned.
    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST-CALLBACK' });
  });

  it('when network is Testnet4, maps to the literal "Testnet4" string (Xverse v2 mode-equality check rejects bare "Testnet")', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ psbtBase64: 'cHNidP8B' } as SignTransactionResponse);
    }) as never);

    await firstValueFrom(xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'tb1qpayment',
      network: Network.Testnet4,
      broadcast: () => of('tx'),
    }));

    const args = signTransactionMock.mock.calls[0][0] as SignTransactionOptions;
    expect(args.payload.network.type).toBe('Testnet4');
  });

  it('when sats-connect onFinish returns a response without psbtBase64, the adapter errors (PSBT missing means signing failed)', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({} as SignTransactionResponse);
    }) as never);

    const result$ = xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    });

    await expect(lastValueFrom(result$)).rejects.toThrow('Xverse signTransaction returned without psbtBase64');
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

  it('when the broadcast callback errors, the adapter propagates the error', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ psbtBase64: 'cHNidP8B' } as SignTransactionResponse);
    }) as never);

    const result$ = xverseSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => { throw new Error('mempool full'); },
    });

    await expect(lastValueFrom(result$)).rejects.toThrow('mempool full');
  });
});
