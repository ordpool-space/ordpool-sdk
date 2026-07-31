import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
import { broadcastSignedPsbt } from '../psbt-extract';

import { wizzSigner } from './wizz.signer';


describe('wizzSigner.signSingleFundingInput', () => {

  let signPsbtMock: jest.Mock;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    (window as unknown as { wizz: { signPsbt: jest.Mock } }).wizz = {
      signPsbt: signPsbtMock,
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { wizz?: unknown }).wizz;
  });

  it('asks wizz.signPsbt with autoFinalized:false and hands the decoded PSBT to the shared broadcast helper', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue('70736274ff01' as never);

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    };
    const result = await firstValueFrom(wizzSigner.signSingleFundingInput(input));

    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    // toSignInputs always passed — see unisat signer spec for
    // rationale (cross-network regtest sign-popup surface).
    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes), {
      autoFinalized: false,
      toSignInputs: [{ index: 0, address: 'bc1qpayment' }],
    });

    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, hex.decode('70736274ff01'));

    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when signPsbt rejects, propagates the error and never reaches the broadcast helper', async () => {
    signPsbtMock.mockRejectedValue(new Error('user rejected') as never);

    const result$ = wizzSigner.signSingleFundingInput({
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

    const result$ = wizzSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('txn-mempool-conflict');
  });
});
