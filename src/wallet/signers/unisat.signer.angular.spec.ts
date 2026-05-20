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

  it('calls window.unisat.signPsbt with the unsigned PSBT as hex, then pushPsbt with the signed PSBT', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue('SIGNED_PSBT_HEX' as never);
    pushPsbtMock.mockResolvedValue('returned-txid' as never);

    const result = await firstValueFrom(unisatSigner.signAndBroadcast({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('IGNORED — unisat broadcasts internally'),
    }));

    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes));
    expect(pushPsbtMock).toHaveBeenCalledTimes(1);
    expect(pushPsbtMock).toHaveBeenCalledWith('SIGNED_PSBT_HEX');
    expect(result).toEqual({ txId: 'returned-txid' });
  });

  it('ignores the broadcast callback — Unisat pushes the tx itself via pushPsbt', async () => {
    signPsbtMock.mockResolvedValue('signed' as never);
    pushPsbtMock.mockResolvedValue('unisat-txid' as never);

    const broadcast = jest.fn(() => of('NEVER CALLED'));

    await firstValueFrom(unisatSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcast as never,
    }));

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('ignores promptForSignedPsbt — Unisat signs in its own UI, watch-only callback is irrelevant', async () => {
    signPsbtMock.mockResolvedValue('signed' as never);
    pushPsbtMock.mockResolvedValue('txid' as never);
    const promptForSignedPsbt = jest.fn();

    await firstValueFrom(unisatSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('txid'),
      promptForSignedPsbt: promptForSignedPsbt as never,
    }));

    expect(promptForSignedPsbt).not.toHaveBeenCalled();
  });

  it('works the same way when promptForSignedPsbt is absent', async () => {
    signPsbtMock.mockResolvedValue('signed' as never);
    pushPsbtMock.mockResolvedValue('plain-txid' as never);

    const result = await firstValueFrom(unisatSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    }));

    expect(result).toEqual({ txId: 'plain-txid' });
  });

  it('propagates a signPsbt rejection without calling pushPsbt', async () => {
    signPsbtMock.mockRejectedValue(new Error('user rejected') as never);

    const result$ = unisatSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user rejected');
    expect(pushPsbtMock).not.toHaveBeenCalled();
  });
});
