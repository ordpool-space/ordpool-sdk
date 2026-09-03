import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../../network';

jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
}));
jest.mock('./child-reveal-finalize.helper', () => {
  const actual = jest.requireActual('./child-reveal-finalize.helper') as Record<string, unknown>;
  return { ...actual, mergeParentSigAndBroadcast: jest.fn() };
});
import { broadcastSignedPsbt } from '../psbt-extract';
import { mergeParentSigAndBroadcast } from './child-reveal-finalize.helper';

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

describe('okxSigner.signChildRevealParentInputs', () => {
  // OKX signs the child reveal via the shared default: it is handed the
  // BARE PSBT (input 1 stripped of the ord envelope leaf, so a plain
  // witnessUtxo) and signs ONLY input 0 at the ordinals address via
  // signPsbt; the SDK merges that signature into the full PSBT. Same shape
  // as the offer flows. Wallet-side proof: the regtest e2e in
  // okx-inscribe-child-roundtrip.spec.ts.
  let signPsbtMock: jest.Mock;
  const mergeMock = mergeParentSigAndBroadcast as unknown as jest.Mock;

  beforeEach(() => {
    signPsbtMock = jest.fn();
    (window as unknown as { okxwallet: { bitcoin: { signPsbt: jest.Mock } } }).okxwallet = {
      bitcoin: { signPsbt: signPsbtMock },
    };
    mergeMock.mockReset();
  });

  afterEach(() => {
    delete (window as unknown as { okxwallet?: unknown }).okxwallet;
  });

  it('signs ONLY input 0 at the ordinals address on the bare PSBT via signPsbt, then merges into the full PSBT', async () => {
    const bare = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x0a]);
    const full = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x0b]);
    signPsbtMock.mockResolvedValue('70736274ff0a' as never);
    mergeMock.mockReturnValue(of({ txId: 'CHILD-TXID' }));
    const broadcast = ((_hex: string) => of('UNUSED')) as never;

    const result = await firstValueFrom(okxSigner.signChildRevealParentInputs({
      psbtBytes: bare,
      finalizePsbtBytes: full,
      ordinalsAddress: 'bc1pordinals',
      ordinalsPublicKey: '02'.padEnd(66, '0'),
      network: Network.Mainnet,
      broadcast,
    }));

    expect(signPsbtMock).toHaveBeenCalledTimes(1);
    const [psbtArg, opts] = signPsbtMock.mock.calls[0] as [string, { autoFinalized: boolean; toSignInputs: { index: number; address?: string }[] }];
    expect(psbtArg).toBe(hex.encode(bare));
    expect(opts.autoFinalized).toBe(false);
    expect(opts.toSignInputs).toEqual([expect.objectContaining({ index: 0, address: 'bc1pordinals' })]);

    // The signed bare-PSBT bytes are merged into the FULL reveal PSBT.
    expect(mergeMock).toHaveBeenCalledTimes(1);
    expect(mergeMock).toHaveBeenCalledWith(hex.decode('70736274ff0a'), full, broadcast);
    expect(result).toEqual({ txId: 'CHILD-TXID' });
  });
});

describe('okxSigner.signMessage', () => {

  let signMessageMock: jest.Mock;

  beforeEach(() => {
    signMessageMock = jest.fn();
    (window as unknown as { okxwallet: { bitcoin: { signMessage: jest.Mock } } }).okxwallet = {
      bitcoin: { signMessage: signMessageMock },
    };
  });

  afterEach(() => {
    delete (window as unknown as { okxwallet?: unknown }).okxwallet;
  });

  it("passes 'bip322-simple' as OKX's POSITIONAL type arg (not an options object) so a Taproot key does not fall back to ecdsa, and returns the witness verbatim", async () => {
    signMessageMock.mockResolvedValue('AUD...bip322witness' as never);

    const result = await firstValueFrom(okxSigner.signMessage({
      address: 'bc1pordinals',
      message: 'ordpool sign-message',
      network: Network.Mainnet,
    }));

    // The whole point of the fix: type is OKX's positional 2nd arg. An
    // options object here would leave type unread and OKX defaults to
    // ecdsa (unverifiable for Taproot). See reown-com/appkit#4162.
    expect(signMessageMock).toHaveBeenCalledTimes(1);
    expect(signMessageMock.mock.calls[0][0]).toBe('ordpool sign-message');
    expect(signMessageMock.mock.calls[0][1]).toBe('bip322-simple');
    expect(result).toEqual({ signature: 'AUD...bip322witness' });
  });
});
