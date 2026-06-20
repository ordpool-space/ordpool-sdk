import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
import { broadcastSignedPsbt } from '../psbt-extract';

import { okxSigner } from './okx.signer';


describe('okxSigner.signSingleFundingInput', () => {

  let signPsbtMock: jest.Mock;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    (window as unknown as { okxwallet: { bitcoin: { signPsbt: jest.Mock } } }).okxwallet = {
      bitcoin: { signPsbt: signPsbtMock },
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { okxwallet?: unknown }).okxwallet;
  });

  it('asks okxwallet.bitcoin.signPsbt with autoFinalized:false + toSignInputs[0]=paymentAddress and hands the decoded PSBT to the shared broadcast helper', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue('70736274ff01' as never);

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    };
    const result = await firstValueFrom(okxSigner.signSingleFundingInput(input));

    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes), {
      autoFinalized: false,
      toSignInputs: [{
        index: 0,
        address: 'bc1qpayment',
        // BIP-341 key-path DEFAULT (0x00) and ALL (0x01) commit to
        // identical wire bytes; OKX accepts either.
        sighashTypes: [0x00, 0x01],
      }],
    });

    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, hex.decode('70736274ff01'));

    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when signPsbt rejects, propagates the error and never reaches the broadcast helper', async () => {
    signPsbtMock.mockRejectedValue(new Error('user rejected') as never);

    const result$ = okxSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user rejected');
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });

  it('when broadcastSignedPsbt errors (mempool rejected), the adapter propagates the error', async () => {
    signPsbtMock.mockResolvedValue('70736274ff01' as never);
    broadcastSignedPsbtMock.mockReturnValue(throwError(() => new Error('txn-mempool-conflict')));

    const result$ = okxSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('txn-mempool-conflict');
  });
});
