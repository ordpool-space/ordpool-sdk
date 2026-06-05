import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
import { broadcastSignedPsbt } from '../psbt-extract';

import { phantomSigner } from './phantom.signer';


describe('phantomSigner.signAndBroadcast', () => {

  let signPSBTMock: jest.Mock;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

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

  it('calls phantom.bitcoin.signPSBT(bytes, {finalize:false, inputsToSign[0]=paymentAddress}) and hands the result to broadcastSignedPsbt', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    const signedBytes = new Uint8Array([0x99, 0x88, 0x77]);
    signPSBTMock.mockResolvedValue(signedBytes as never);

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    };
    const result = await firstValueFrom(phantomSigner.signAndBroadcast(input));

    expect(signPSBTMock).toHaveBeenCalledTimes(1);
    const [psbtArg, optsArg] = signPSBTMock.mock.calls[0] as [
      Uint8Array,
      { inputsToSign: { address: string; signingIndexes: number[]; sigHash?: number }[]; finalize: boolean },
    ];
    expect(psbtArg).toBe(unsignedBytes);
    expect(optsArg.finalize).toBe(false);
    expect(optsArg.inputsToSign).toEqual([{
      address: 'bc1qpayment',
      signingIndexes: [0],
      sigHash: 0x01,
    }]);

    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, signedBytes);

    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when signPSBT rejects, propagates the error and never reaches the broadcast helper', async () => {
    signPSBTMock.mockRejectedValue(new Error('user rejected') as never);

    const result$ = phantomSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user rejected');
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });

  it('when broadcastSignedPsbt errors (mempool rejected), the adapter propagates the error', async () => {
    signPSBTMock.mockResolvedValue(new Uint8Array([0xab]) as never);
    broadcastSignedPsbtMock.mockReturnValue(throwError(() => new Error('txn-mempool-conflict')));

    const result$ = phantomSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('txn-mempool-conflict');
  });
});
