import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
import { broadcastSignedPsbt } from '../psbt-extract';

import { albySigner } from './alby.signer';


describe('albySigner.signAndBroadcast', () => {

  let enableMock: jest.Mock;
  let signPsbtMock: jest.Mock;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

  beforeEach(() => {
    enableMock = jest.fn();
    enableMock.mockResolvedValue(undefined as never);
    signPsbtMock = jest.fn();
    (window as unknown as { alby: { enable: jest.Mock; getBitcoin: () => unknown } }).alby = {
      enable: enableMock,
      getBitcoin: () => ({ signPsbt: signPsbtMock }),
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { alby?: unknown }).alby;
  });

  it('calls alby.enable() then getBitcoin().signPsbt(hex) and hands the decoded result to broadcastSignedPsbt', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue({ signed: '70736274ff01' } as never);

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    };
    const result = await firstValueFrom(albySigner.signAndBroadcast(input));

    expect(enableMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes));

    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, hex.decode('70736274ff01'));

    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when alby.enable() rejects, propagates the error and never reaches signPsbt or broadcast', async () => {
    enableMock.mockRejectedValue(new Error('user denied') as never);

    const result$ = albySigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user denied');
    expect(signPsbtMock).toHaveBeenCalledTimes(0);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });

  it('when signPsbt rejects (e.g. Alby has no on-chain backend), propagates the error', async () => {
    signPsbtMock.mockRejectedValue(new Error('No bitcoin wallet connected to Alby account') as never);

    const result$ = albySigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('No bitcoin wallet connected to Alby account');
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });

  it('when broadcastSignedPsbt errors (mempool rejected), the adapter propagates the error', async () => {
    signPsbtMock.mockResolvedValue({ signed: '70736274ff01' } as never);
    broadcastSignedPsbtMock.mockReturnValue(throwError(() => new Error('txn-mempool-conflict')));

    const result$ = albySigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('txn-mempool-conflict');
  });
});
