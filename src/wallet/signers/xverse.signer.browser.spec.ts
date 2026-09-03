import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, lastValueFrom, of } from 'rxjs';
import { BitcoinNetworkType, SignTransactionOptions, SignTransactionResponse } from 'sats-connect';

import { Network } from '../../network';

// Mocks must be in place BEFORE the signer-under-test is imported.
jest.mock('sats-connect', () => {
  const actual = jest.requireActual('sats-connect') as Record<string, unknown>;
  return {
    ...actual,
    signTransaction: jest.fn(),
    request: jest.fn(),
  };
});
jest.mock('../psbt-extract', () => ({
  broadcastSignedPsbt: jest.fn(() => of({ txId: 'TXID-FROM-BROADCAST' })),
  extractWireTxFromPsbt: jest.fn(() => '00'),
}));
jest.mock('./child-reveal-finalize.helper', () => {
  const actual = jest.requireActual('./child-reveal-finalize.helper') as Record<string, unknown>;
  return {
    ...actual,
    mergeParentSigAndBroadcast: jest.fn(),
  };
});
import { signTransaction, request, MessageSigningProtocols } from 'sats-connect';
import { broadcastSignedPsbt } from '../psbt-extract';
import { mergeParentSigAndBroadcast } from './child-reveal-finalize.helper';

import { xverseSigner } from './xverse.signer';


describe('xverseSigner.signSingleFundingInput', () => {

  const signTransactionMock = signTransaction as unknown as jest.Mock;
  const broadcastSignedPsbtMock = broadcastSignedPsbt as unknown as jest.Mock;

  beforeEach(() => {
    signTransactionMock.mockReset();
    broadcastSignedPsbtMock.mockReset();
    broadcastSignedPsbtMock.mockReturnValue(of({ txId: 'TXID-FROM-BROADCAST' }));
  });

  it('asks sats-connect to sign WITHOUT broadcasting, extracts the wire tx, and hands it to the caller\'s broadcast callback', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      // With broadcast:false Xverse returns the signed PSBT in
      // base64 instead of a txId.
      args.onFinish({ psbtBase64: 'cHNidP8B' } as SignTransactionResponse);
    }) as never);

    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0xab]);
    const broadcastCallback = jest.fn((_rawTxHex: string) => of('UNUSED'));

    const input = {
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: broadcastCallback as never,
    };
    const result = await firstValueFrom(xverseSigner.signSingleFundingInput(input));

    expect(signTransactionMock).toHaveBeenCalledTimes(1);
    const args = signTransactionMock.mock.calls[0][0] as SignTransactionOptions;
    expect(args.payload.psbtBase64).toBe(base64.encode(unsignedBytes));
    // WE-broadcast convention: ask for sign-only.
    expect(args.payload.broadcast).toBe(false);
    expect(args.payload.network.type).toBe(BitcoinNetworkType.Mainnet);
    expect(args.payload.inputsToSign).toBeDefined();
    expect(args.payload.inputsToSign![0].address).toBe('bc1qpayment');
    expect(args.payload.inputsToSign![0].signingIndexes).toEqual([0]);
    expect(args.payload.inputsToSign![0].sigHash).toBe(btc.SigHash.ALL);

    // Signer hands the decoded PSBT to the shared broadcast helper.
    expect(broadcastSignedPsbtMock).toHaveBeenCalledTimes(1);
    expect(broadcastSignedPsbtMock).toHaveBeenCalledWith(input, base64.decode('cHNidP8B'));

    // Result.txId is what the broadcast helper returned.
    expect(result).toEqual({ txId: 'TXID-FROM-BROADCAST' });
  });

  it('when network is Testnet4, maps to the literal "Testnet4" string (Xverse v2 mode-equality check rejects bare "Testnet")', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ psbtBase64: 'cHNidP8B' } as SignTransactionResponse);
    }) as never);

    await firstValueFrom(xverseSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'tb1qpayment',
      network: Network.Testnet4,
      broadcast: () => of('tx'),
    }));

    const args = signTransactionMock.mock.calls[0][0] as SignTransactionOptions;
    expect(args.payload.network.type).toBe('Testnet4');
  });

  it('when sats-connect onFinish returns a response without psbtBase64, the adapter errors (PSBT missing means signing failed)', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({} as SignTransactionResponse);
    }) as never);

    const result$ = xverseSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    });

    await expect(lastValueFrom(result$)).rejects.toThrow('Xverse signTransaction returned without psbtBase64');
  });

  it('when sats-connect calls onCancel, the adapter throws an error to the caller', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onCancel();
    }) as never);

    const result$ = xverseSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('unused'),
    });

    await expect(lastValueFrom(result$)).rejects.toThrow('Request was cancelled');
  });

  it('when broadcastSignedPsbt errors (e.g. mempool rejected), the adapter propagates the error', async () => {
    signTransactionMock.mockImplementation(((args: SignTransactionOptions) => {
      args.onFinish({ psbtBase64: 'cHNidP8B' } as SignTransactionResponse);
    }) as never);
    broadcastSignedPsbtMock.mockImplementation(() => {
      throw new Error('mempool full');
    });

    const result$ = xverseSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(8),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('UNUSED'),
    });

    await expect(lastValueFrom(result$)).rejects.toThrow('mempool full');
  });
});

describe('xverseSigner.signChildRevealParentInputs', () => {
  const requestMock = request as unknown as jest.Mock;
  const mergeMock = mergeParentSigAndBroadcast as unknown as jest.Mock;

  beforeEach(() => {
    requestMock.mockReset();
    mergeMock.mockReset();
  });

  it('routes the child-reveal parent input onto modern signPsbt (not legacy signTransaction), signs ONLY input 0 at the ordinals address, then merges into the FULL reveal psbt and broadcasts', async () => {
    // The legacy signTransaction path hangs on the reveal's foreign
    // ephemeral-commit input 1; this override signs input 0 alone via
    // modern signPsbt and leaves the foreign input to the SDK's finalize.
    requestMock.mockResolvedValue({ status: 'success', result: { psbt: 'c2lnbmVk' } } as never); // base64("signed")
    mergeMock.mockReturnValue(of({ txId: 'CHILD-REVEAL-TXID' }) as never);

    const bareBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
    const fullBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x02]);
    const broadcastCallback = jest.fn((_hex: string) => of('UNUSED'));

    const result = await firstValueFrom(xverseSigner.signChildRevealParentInputs({
      psbtBytes: bareBytes,
      finalizePsbtBytes: fullBytes,
      ordinalsAddress: 'bcrt1pordinals',
      ordinalsPublicKey: '02'.padEnd(66, 'a'),
      network: Network.Regtest,
      broadcast: broadcastCallback as never,
    }));

    // Modern signPsbt, sign-only, scoped to input 0 at the ordinals address.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe('signPsbt');
    const payload = requestMock.mock.calls[0][1] as { psbt: string; signInputs: Record<string, number[]>; broadcast: boolean };
    expect(payload.psbt).toBe(base64.encode(bareBytes));
    expect(payload.signInputs).toEqual({ 'bcrt1pordinals': [0] });
    expect(payload.broadcast).toBe(false);

    // The wallet's input-0 signature is merged into the FULL psbt, not the bare one.
    expect(mergeMock).toHaveBeenCalledTimes(1);
    expect(mergeMock).toHaveBeenCalledWith(base64.decode('c2lnbmVk'), fullBytes, broadcastCallback);

    expect(result).toEqual({ txId: 'CHILD-REVEAL-TXID' });
  });
});

describe('xverseSigner.signTransfer', () => {
  const requestMock = request as unknown as jest.Mock;

  beforeEach(() => { requestMock.mockReset(); });

  it('routes transfer onto modern signPsbt (not legacy signTransaction): input 0 at the ordinals address + funding inputs 1..N at the payment address, sign-only, then broadcasts the extracted wire tx', async () => {
    requestMock.mockResolvedValue({ status: 'success', result: { psbt: 'c2lnbmVk' } } as never);
    const bytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x10]);
    const broadcast = jest.fn((_hex: string) => of('TRANSFER-TXID'));

    const result = await firstValueFrom(xverseSigner.signTransfer({
      psbtBytes: bytes,
      ordinalsAddress: 'bcrt1pord',
      paymentAddress: 'bcrt1qpay',
      fundingInputCount: 2,
      network: Network.Regtest,
      broadcast: broadcast as never,
    }));

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe('signPsbt');
    const payload = requestMock.mock.calls[0][1] as { psbt: string; signInputs: Record<string, number[]>; broadcast: boolean };
    expect(payload.psbt).toBe(base64.encode(bytes));
    expect(payload.signInputs).toEqual({ 'bcrt1pord': [0], 'bcrt1qpay': [1, 2] });
    expect(payload.broadcast).toBe(false);
    // WE-broadcast convention: the extracted wire tx (mocked '00') goes to the caller's callback.
    expect(broadcast).toHaveBeenCalledWith('00');
    expect(result).toEqual({ txId: 'TRANSFER-TXID' });
  });
});

describe('xverseSigner.signOfferCreatePsbt', () => {
  const requestMock = request as unknown as jest.Mock;

  beforeEach(() => { requestMock.mockReset(); });

  it('routes offer-create onto modern signPsbt (not legacy signTransaction): buyer signs ONLY funding inputs 1..N at the payment address (input 0 = seller cat untouched), returns partial-sig bytes, no broadcast', async () => {
    requestMock.mockResolvedValue({ status: 'success', result: { psbt: 'c2lnbmVk' } } as never); // base64("signed")
    const bytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x20]);

    const signed = await firstValueFrom(xverseSigner.signOfferCreatePsbt({
      psbtBytes: bytes,
      paymentAddress: 'bcrt1qpay',
      fundingInputCount: 1,
      network: Network.Regtest,
    }));

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe('signPsbt');
    const payload = requestMock.mock.calls[0][1] as { psbt: string; signInputs: Record<string, number[]>; broadcast: boolean };
    expect(payload.signInputs).toEqual({ 'bcrt1qpay': [1] });
    expect(payload.broadcast).toBe(false);
    // Returns the signed partial PSBT bytes verbatim (no broadcast on this path).
    expect(signed).toEqual(base64.decode('c2lnbmVk'));
  });
});

describe('xverseSigner.signMessage', () => {
  const requestMock = request as unknown as jest.Mock;

  beforeEach(() => { requestMock.mockReset(); });

  it('signs via the low-level sats-connect request (not Wallet.request, which pops an un-dismissable in-page wallet picker): BIP-322 protocol, ordinals address, returns the base64 signature', async () => {
    requestMock.mockResolvedValue({ status: 'success', result: { signature: 'BASE64_BIP322_SIG' } } as never);

    const result = await firstValueFrom(xverseSigner.signMessage({
      address: 'bc1pordinals',
      message: 'ordpool sign-message',
      network: Network.Mainnet,
    }));

    // The whole point of the fix: bare `request('signMessage', …)`, so a
    // connected wallet never re-opens the "Choose wallet to connect" picker.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe('signMessage');
    const payload = requestMock.mock.calls[0][1] as { address: string; message: string; protocol: unknown };
    expect(payload.address).toBe('bc1pordinals');
    expect(payload.message).toBe('ordpool sign-message');
    expect(payload.protocol).toBe(MessageSigningProtocols.BIP322);
    expect(result).toEqual({ signature: 'BASE64_BIP322_SIG' });
  });

  it('throws with the wallet-reported reason when sats-connect returns a non-success status', async () => {
    requestMock.mockResolvedValue({ status: 'error', error: { message: 'user rejected', code: 4001 } } as never);

    await expect(firstValueFrom(xverseSigner.signMessage({
      address: 'bc1pordinals',
      message: 'x',
      network: Network.Mainnet,
    }))).rejects.toThrow('user rejected');
  });
});
