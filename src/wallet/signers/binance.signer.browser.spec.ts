import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
import { broadcastSignedPsbt } from '../psbt-extract';

import { binanceSigner } from './binance.signer';
import { binanceConnector } from '../connectors/binance.connector';

/**
 * Happy-path pins for the Binance Web3 Wallet adapter. There is no
 * Pipeline B for Binance (the shipped binary injects no
 * `window.binancew3w.bitcoin`), but the signer auto-activates in
 * production the day Binance exposes the documented surface — so the
 * adapter's call shapes must be pinned by unit tests, exactly like
 * every other signer.
 */
describe('binanceSigner.signSingleFundingInput', () => {

  let signPsbtMock: jest.Mock;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    (window as unknown as { binancew3w: { bitcoin: { signPsbt: jest.Mock } } }).binancew3w = {
      bitcoin: { signPsbt: signPsbtMock },
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { binancew3w?: unknown }).binancew3w;
  });

  it('asks binancew3w.bitcoin.signPsbt with autoFinalized:false + toSignInputs[0]=paymentAddress and hands the decoded PSBT to the shared broadcast helper', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue('70736274ff01' as never);

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    };
    const result = await firstValueFrom(binanceSigner.signSingleFundingInput(input));

    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes), {
      autoFinalized: false,
      toSignInputs: [{
        index: 0,
        address: 'bc1qpayment',
        // BIP-341 key-path DEFAULT (0x00) and ALL (0x01) commit to
        // identical wire bytes; accept either.
        sighashTypes: [0x00, 0x01],
      }],
    });

    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, hex.decode('70736274ff01'));
    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when signPsbt rejects, propagates the error and never reaches the broadcast helper', async () => {
    signPsbtMock.mockRejectedValue(new Error('user rejected') as never);

    const result$ = binanceSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user rejected');
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(0);
  });
});

describe('binanceSigner.signTransfer', () => {

  let signPsbtMock: jest.Mock;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    (window as unknown as { binancew3w: { bitcoin: { signPsbt: jest.Mock } } }).binancew3w = {
      bitcoin: { signPsbt: signPsbtMock },
    };
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  afterEach(() => {
    delete (window as unknown as { binancew3w?: unknown }).binancew3w;
  });

  it('signTransfer: cat input at ordinalsAddress (index 0) + N funding inputs at paymentAddress (indexes 1..N), Unisat-family sighash whitelist per address type', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    signPsbtMock.mockResolvedValue('70736274ff01' as never);

    await firstValueFrom(binanceSigner.signTransfer({
      psbtBytes: unsignedBytes,
      ordinalsAddress: 'bc1pordinals',
      paymentAddress: 'bc1qpayment',
      fundingInputCount: 2,
      network: Network.Mainnet,
      broadcast: ((_rawTxHex: string) => of('UNUSED')) as never,
    }));

    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes), {
      autoFinalized: false,
      toSignInputs: [
        // Taproot ordinals input: DEFAULT (0x00) + ALL (0x01) — a Taproot
        // key-path input is commonly encoded SIGHASH_DEFAULT, and Binance's
        // Unisat-derived policy check refuses rows that omit it.
        { index: 0, address: 'bc1pordinals', sighashTypes: [btc.SigHash.DEFAULT, btc.SigHash.ALL] },
        // P2WPKH payment inputs: exactly ALL (0x00 is Taproot-only).
        { index: 1, address: 'bc1qpayment', sighashTypes: [btc.SigHash.ALL] },
        { index: 2, address: 'bc1qpayment', sighashTypes: [btc.SigHash.ALL] },
      ],
    });
  });
});

describe('binanceSigner.signOfferCreatePsbt', () => {

  let signPsbtMock: jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    (window as unknown as { binancew3w: { bitcoin: { signPsbt: jest.Mock } } }).binancew3w = {
      bitcoin: { signPsbt: signPsbtMock },
    };
  });

  afterEach(() => {
    delete (window as unknown as { binancew3w?: unknown }).binancew3w;
  });

  it('signs ONLY the buyer funding inputs 1..N at paymentAddress and returns the partial-sig PSBT bytes without broadcasting', async () => {
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x02]);
    signPsbtMock.mockResolvedValue('70736274ff0b' as never);

    const signed = await firstValueFrom(binanceSigner.signOfferCreatePsbt({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      fundingInputCount: 2,
      network: Network.Mainnet,
    }));

    expect(signPsbtMock).toHaveBeenCalledWith(hex.encode(unsignedBytes), {
      autoFinalized: false,
      toSignInputs: [
        { index: 1, address: 'bc1qpayment', sighashTypes: [btc.SigHash.ALL] },
        { index: 2, address: 'bc1qpayment', sighashTypes: [btc.SigHash.ALL] },
      ],
    });
    // Returns the signed partial PSBT bytes verbatim (no broadcast on this path).
    expect(signed).toEqual(hex.decode('70736274ff0b'));
  });
});

describe('binanceConnector.connect', () => {

  afterEach(() => {
    delete (window as unknown as { binancew3w?: unknown }).binancew3w;
  });

  it('connect resolves requestAccounts[0] + getPublicKey into a single-address WalletInfo (ordinals lane === payment lane)', async () => {
    const requestAccounts = jest.fn(async () => ['bc1p-binance-active']);
    const getPublicKey = jest.fn(async () => '02'.padEnd(66, 'b'));
    (window as unknown as { binancew3w: unknown }).binancew3w = {
      bitcoin: { requestAccounts, getPublicKey },
    };
    const info = await firstValueFrom(binanceConnector.connect(Network.Mainnet));

    expect(requestAccounts).toHaveBeenCalledTimes(1);
    expect(info.type).toBe('binance');
    expect(info.ordinalsAddress).toBe('bc1p-binance-active');
    expect(info.paymentAddress).toBe('bc1p-binance-active');
    expect(info.ordinalsPublicKey).toBe('02'.padEnd(66, 'b'));
    expect(info.paymentPublicKey).toBe('02'.padEnd(66, 'b'));
  });

  it('connect rejects (not a silent undefined-address success) when requestAccounts returns an empty array', async () => {
    const requestAccounts = jest.fn(async () => [] as string[]);
    const getPublicKey = jest.fn(async () => '02'.padEnd(66, 'b'));
    (window as unknown as { binancew3w: unknown }).binancew3w = {
      bitcoin: { requestAccounts, getPublicKey },
    };
    await expect(firstValueFrom(binanceConnector.connect(Network.Mainnet)))
      .rejects.toThrow(/no accounts|empty|address/i);
  });
});
