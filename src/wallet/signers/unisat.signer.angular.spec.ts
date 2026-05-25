import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  extractWireTxFromPsbt: jest.fn(() => 'EXTRACTED_RAW_TX_HEX'),
}));
import { extractWireTxFromPsbt } from '../psbt-extract';

import { unisatSigner } from './unisat.signer';


describe('unisatSigner.signAndBroadcast', () => {

  let signPsbtMock: jest.Mock;
  const extractMock = extractWireTxFromPsbt as unknown as jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    (window as unknown as { unisat: { signPsbt: jest.Mock } }).unisat = {
      signPsbt: signPsbtMock,
    };
    extractMock.mockReset();
    extractMock.mockReturnValue('EXTRACTED_RAW_TX_HEX');
  });

  afterEach(() => {
    delete (window as unknown as { unisat?: unknown }).unisat;
  });

  it('asks unisat.signPsbt with autoFinalized:false, extracts the wire tx, and hands it to the caller\'s broadcast callback', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue('70736274ff01' as never);
    const broadcastMock = jest.fn((_rawTxHex: string) => of('TXID-FROM-BROADCAST-CALLBACK'));

    const result = await firstValueFrom(unisatSigner.signAndBroadcast({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    }));

    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes), { autoFinalized: false });

    // Signer decodes the returned PSBT, extracts wire tx, and
    // hands it to the broadcast callback.
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(extractMock).toHaveBeenCalledWith(hex.decode('70736274ff01'));
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith('EXTRACTED_RAW_TX_HEX');

    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST-CALLBACK' });
  });

  it('when signPsbt rejects, re-throws the same error to the caller (and never calls broadcast)', async () => {
    signPsbtMock.mockRejectedValue(new Error('user rejected') as never);
    const broadcastMock = jest.fn(() => of('would-leak'));

    const result$ = unisatSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user rejected');
    // Positive sentinel-based proof that the broadcast callback was
    // not invoked: it returns a distinct string we'd see in result.txId
    // if the adapter routed through it.
    expect(broadcastMock).toHaveBeenCalledTimes(0);
  });

  it('when the broadcast callback errors (e.g. mempool rejected), the adapter propagates the error', async () => {
    signPsbtMock.mockResolvedValue('70736274ff01' as never);

    const result$ = unisatSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => throwError(() => new Error('txn-mempool-conflict')),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('txn-mempool-conflict');
  });
});
