import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { base64, hex } from '@scure/base';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
import { broadcastSignedPsbt } from '../psbt-extract';

import { oylSigner } from './oyl.signer';


describe('oylSigner.signSingleFundingInput', () => {

  let signPsbtMock: jest.Mock;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    (window as unknown as { oyl: { signPsbt: jest.Mock } }).oyl = { signPsbt: signPsbtMock };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { oyl?: unknown }).oyl;
  });

  it('asks oyl.signPsbt with psbt (hex) + inputsToSign[0]=paymentAddress + broadcast:false + finalize:false and hands the decoded result to broadcastSignedPsbt', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue({ signedPsbt: 'cHNidP8B' } as never);

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    };
    const result = await firstValueFrom(oylSigner.signSingleFundingInput(input));

    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledWith({
      psbt: hex.encode(unsignedBytes),
      inputsToSign: [{
        address: 'bc1qpayment',
        signingIndexes: [0],
        sigHash: 0x01,
      }],
      broadcast: false,
      finalize: false,
    });

    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, base64.decode('cHNidP8B'));

    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when signPsbt rejects, propagates the error and never reaches the broadcast helper', async () => {
    signPsbtMock.mockRejectedValue(new Error('user rejected') as never);

    const result$ = oylSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user rejected');
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });

  it('when broadcastSignedPsbt errors (mempool rejected), the adapter propagates the error', async () => {
    signPsbtMock.mockResolvedValue({ signedPsbt: 'cHNidP8B' } as never);
    broadcastSignedPsbtMock.mockReturnValue(throwError(() => new Error('txn-mempool-conflict')));

    const result$ = oylSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('txn-mempool-conflict');
  });
});
