import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

import { albySigner } from './alby.signer';


describe('albySigner.signAndBroadcast', () => {

  let albyEnableMock: jest.Mock;
  let webbtcEnableMock: jest.Mock;
  let signPsbtMock: jest.Mock;
  let broadcastMock: jest.Mock;

  beforeEach(() => {
    albyEnableMock = jest.fn();
    albyEnableMock.mockResolvedValue(undefined as never);
    webbtcEnableMock = jest.fn();
    webbtcEnableMock.mockResolvedValue(undefined as never);
    signPsbtMock = jest.fn();
    (window as unknown as { alby: { enable: jest.Mock; webbtc: unknown } }).alby = {
      enable: albyEnableMock,
      webbtc: { enable: webbtcEnableMock, signPsbt: signPsbtMock },
    };
    broadcastMock = jest.fn();
  });

  afterEach(() => {
    delete (window as unknown as { alby?: unknown }).alby;
  });

  it('calls alby.enable(), alby.webbtc.enable(), then webbtc.signPsbt(hex, {sighashTypes:[0,1]}) and broadcasts the returned wire-tx hex directly', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue({ signed: '0200000001abcd' } as never);
    broadcastMock.mockReturnValue(of('TXID-FROM-BROADCAST'));

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    };
    const result = await firstValueFrom(albySigner.signAndBroadcast(input));

    expect(albyEnableMock).toHaveBeenCalledTimes(1);
    expect(webbtcEnableMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes), { sighashTypes: [0x00, 0x01] });

    // Wire-tx hex from Alby goes straight to input.broadcast — no
    // PSBT extract step. The result is the txId from broadcast.
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith('0200000001abcd');
    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when alby.enable() rejects, propagates the error and never reaches signPsbt or broadcast', async () => {
    albyEnableMock.mockRejectedValue(new Error('user denied') as never);
    broadcastMock.mockReturnValue(of('UNUSED'));

    const result$ = albySigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user denied');
    expect(signPsbtMock).toHaveBeenCalledTimes(0);
    expect(broadcastMock).toHaveBeenCalledTimes(0);
  });

  it('when signPsbt rejects (e.g. Alby has no on-chain backend), propagates the error and never broadcasts', async () => {
    signPsbtMock.mockRejectedValue(new Error('No bitcoin wallet connected to Alby account') as never);
    broadcastMock.mockReturnValue(of('UNUSED'));

    const result$ = albySigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('No bitcoin wallet connected to Alby account');
    expect(broadcastMock).toHaveBeenCalledTimes(0);
  });

  it('when input.broadcast errors (mempool rejected), the adapter propagates the error', async () => {
    signPsbtMock.mockResolvedValue({ signed: '0200000001abcd' } as never);
    broadcastMock.mockReturnValue(throwError(() => new Error('txn-mempool-conflict')));

    const result$ = albySigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('txn-mempool-conflict');
  });

  it('handles wallets where webbtc.enable is undefined (older Alby builds)', async () => {
    (window as unknown as { alby: { enable: jest.Mock; webbtc: unknown } }).alby = {
      enable: albyEnableMock,
      webbtc: { signPsbt: signPsbtMock },
    };
    signPsbtMock.mockResolvedValue({ signed: '0200000001abcd' } as never);
    broadcastMock.mockReturnValue(of('TXID-FROM-BROADCAST'));

    const result = await firstValueFrom(albySigner.signAndBroadcast({
      psbtBytes: new Uint8Array([1, 2, 3]),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    }));

    expect(albyEnableMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });
});
