import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import { firstValueFrom, of } from 'rxjs';

import { Network } from '../../network';
import { unisatSigner } from './unisat.signer';


describe('unisatSigner.signAndBroadcast', () => {

  let signPsbtMock: jest.Mock;
  let pushPsbtMock: jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    pushPsbtMock = jest.fn();
    (window as unknown as { unisat: { signPsbt: jest.Mock; pushPsbt: jest.Mock } }).unisat = {
      signPsbt: signPsbtMock,
      pushPsbt: pushPsbtMock,
    };
  });

  afterEach(() => {
    delete (window as unknown as { unisat?: unknown }).unisat;
  });

  it('when called, hits window.unisat.signPsbt with hex(unsigned), then pushPsbt with the signed PSBT, and returns pushPsbt\'s txid', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue('SIGNED_PSBT_HEX' as never);
    pushPsbtMock.mockResolvedValue('txid-from-pushPsbt' as never);

    const result = await firstValueFrom(unisatSigner.signAndBroadcast({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      // Distinct sentinel: if our adapter accidentally routes through the
      // broadcast callback instead of unisat.pushPsbt, the result.txId
      // assertion below catches it.
      broadcast: () => of('LEAKED-FROM-BROADCAST-CALLBACK'),
    }));

    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes));
    expect(pushPsbtMock).toHaveBeenCalledTimes(1);
    expect(pushPsbtMock).toHaveBeenCalledWith('SIGNED_PSBT_HEX');
    expect(result).toEqual({ txId: 'txid-from-pushPsbt' });
  });

  it('when signPsbt rejects, re-throws the same error to the caller', async () => {
    signPsbtMock.mockRejectedValue(new Error('user rejected') as never);

    const result$ = unisatSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user rejected');
  });
});
