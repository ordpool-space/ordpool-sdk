import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

import { albySigner } from './alby.signer';


describe('albySigner.signSingleFundingInput', () => {

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
    const result = await firstValueFrom(albySigner.signSingleFundingInput(input));

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

    const result$ = albySigner.signSingleFundingInput({
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

    const result$ = albySigner.signSingleFundingInput({
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

    const result$ = albySigner.signSingleFundingInput({
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

    const result = await firstValueFrom(albySigner.signSingleFundingInput({
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


/**
 * Pipeline A (mock-based) — pins OUR Alby adapter's rejection of every
 * per-input signing flow. Alby's `webbtc.signPsbt` signs EVERY input in
 * the PSBT with one Taproot key (verified against background.bundle.js;
 * no `toSignInputs` / `signInputs` knob), so `alby.signer.ts` refuses
 * transfer / offer-accept / offer-create up front rather than hand Alby a
 * PSBT it would over-sign. This proves OUR adapter errors with the exact
 * message and does NOT reach the wallet — it says nothing about Alby itself.
 *
 * These paths are otherwise untested: the Alby e2e roundtrips drive Alby's
 * internal `webbtc/signPsbt` route directly and bypass `alby.signer.ts`, so
 * a regression that let these methods fall through to signing would ship
 * green without this guard.
 */
describe('albySigner rejects per-input flows (Alby has no per-input signing knob)', () => {

  let signPsbtMock: jest.Mock;
  let broadcastMock: jest.Mock;

  beforeEach(() => {
    // A distinct, resolvable stand-in: if a regression made any of these
    // flows fall through to the wallet, the observable would EMIT this
    // sentinel-derived txId instead of erroring — the assertions below
    // (rejects.toThrow) positively catch that leak.
    signPsbtMock = jest.fn();
    signPsbtMock.mockResolvedValue({ signed: 'LEAKED-WIRE-TX' } as never);
    (window as unknown as { alby: { enable: jest.Mock; webbtc: unknown } }).alby = {
      enable: jest.fn(),
      webbtc: { enable: jest.fn(), signPsbt: signPsbtMock },
    };
    broadcastMock = jest.fn();
    broadcastMock.mockReturnValue(of('LEAKED-TXID'));
  });

  afterEach(() => {
    delete (window as unknown as { alby?: unknown }).alby;
  });

  it('signTransfer errors with the "no per-input signing" message', async () => {
    const result$ = albySigner.signTransfer({
      psbtBytes: new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]),
      ordinalsAddress: 'bc1pordinals',
      paymentAddress: 'bc1qpayment',
      fundingInputCount: 1,
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    });

    await expect(firstValueFrom(result$)).rejects.toThrow(
      'Alby does not support per-input signing yet (no toSignInputs / signInputs knob in current webbtc API). Use Xverse, Leather, Unisat, or CAT-21 wallet for transfer / offer flows.',
    );
  });

  it('signOfferAccept errors with the "no per-input signing" message', async () => {
    const result$ = albySigner.signOfferAccept({
      psbtBytes: new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]),
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: '02'.padEnd(66, '0'),
      network: Network.Mainnet,
      broadcast: broadcastMock as never,
    });

    await expect(firstValueFrom(result$)).rejects.toThrow(
      'Alby does not support per-input signing yet (no toSignInputs / signInputs knob in current webbtc API). Use Xverse, Leather, Unisat, or CAT-21 wallet for transfer / offer flows.',
    );
  });

  it('signOfferCreatePsbt errors with the offer-create "no per-input signing" message', async () => {
    const result$ = albySigner.signOfferCreatePsbt({
      psbtBytes: new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]),
      paymentAddress: 'bc1qpayment',
      fundingInputCount: 1,
      network: Network.Mainnet,
    });

    await expect(firstValueFrom(result$)).rejects.toThrow(
      'Alby does not support per-input signing yet (no toSignInputs / signInputs knob in current webbtc API). Use Xverse, Leather, Unisat, or CAT-21 wallet for offer-create.',
    );
  });
});
