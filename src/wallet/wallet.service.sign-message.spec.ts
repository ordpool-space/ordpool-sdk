import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { firstValueFrom, Observable, of, throwError } from 'rxjs';

import { Network } from '../network';
import { WalletService } from './wallet.service';
import {
  KnownOrdinalWalletType,
  SignMessageArgs,
  SignMessageResult,
  WalletInfo,
} from './wallet.service.types';

// Mock the signers registry — pin THIS service's dispatch, not the
// per-wallet signMessage correctness (each signer file has its own spec).
const mockSignMessage = jest.fn<(args: SignMessageArgs) => Observable<SignMessageResult>>();

jest.mock('./signers', () => ({
  walletSigners: [],
  findSignerOrThrow: jest.fn(() => ({
    providerId: 'mock-provider',
    signMessage: (args: SignMessageArgs) => mockSignMessage(args),
    // Other signer methods aren't invoked in this suite; return empty stubs.
    signSingleFundingInput: jest.fn(),
    signTransfer: jest.fn(),
    signOfferAccept: jest.fn(),
    signOfferCreatePsbt: jest.fn(),
  })),
}));

// Mock the BIP-322 verifier — this suite pins the dispatch/gate
// wiring, not the crypto path. The verify-bip322-signature spec
// already covers the crypto correctness. Default: verify passes; a
// test that wants to trigger the post-verify rejection returns
// `{ ok: false, reason: ... }`.
const mockVerifyBip322 = jest.fn<(args: unknown) => { ok: boolean; reason?: string }>();
jest.mock('./verify-bip322-signature', () => ({
  verifyBip322Signature: (args: unknown) => mockVerifyBip322(args),
}));

const wallet: WalletInfo = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: 'bc1p-ord',
  ordinalsPublicKey: '02aa',
  paymentAddress: 'bc1q-pay',
  paymentPublicKey: '02bb',
  signingSupported: true,
};

function newService(): WalletService {
  // Manual instantiation with faked deps — mirrors other WalletService spec patterns.
  const service = Object.create(WalletService.prototype);
  service.connectedWallet$ = { getValue: () => null } as never;
  service.network = Network.Mainnet;
  return service;
}

describe('WalletService.signMessage', () => {

  beforeEach(() => {
    mockSignMessage.mockReset();
    mockVerifyBip322.mockReset().mockReturnValue({ ok: true });
  });

  it('errors with "No wallet connected" when no wallet is present', async () => {
    const service = newService();
    let caught: Error | null = null;
    try {
      await firstValueFrom(service.signMessage({ address: 'bc1p-ord', message: 'hi', network: Network.Mainnet }));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain('No wallet connected');
    // Signer registry should not be reached.
    expect(mockSignMessage).not.toHaveBeenCalled();
  });

  it('dispatches to the connected wallet\'s signer.signMessage', async () => {
    const service = newService();
    service['connectedWallet$'] = { getValue: () => wallet } as never;
    mockSignMessage.mockReturnValue(of({ signature: 'sig-base64-bytes' }));

    const result = await firstValueFrom(service.signMessage({
      address: 'bc1p-ord',
      message: 'cat21-ask:v1\n...',
      network: Network.Mainnet,
    }));

    expect(mockSignMessage).toHaveBeenCalledTimes(1);
    expect(mockSignMessage.mock.calls[0]?.[0]).toEqual({
      address: 'bc1p-ord',
      message: 'cat21-ask:v1\n...',
      network: Network.Mainnet,
    });
    expect(result).toEqual({ signature: 'sig-base64-bytes' });
    // Post-verify ran against the caller-requested address.
    expect(mockVerifyBip322).toHaveBeenCalledWith({
      address: 'bc1p-ord',
      message: 'cat21-ask:v1\n...',
      signatureBase64: 'sig-base64-bytes',
    });
  });

  it('propagates a signer-side error observable', async () => {
    const service = newService();
    service['connectedWallet$'] = { getValue: () => wallet } as never;
    mockSignMessage.mockReturnValue(throwError(() => new Error('User rejected')));

    let caught: Error | null = null;
    try {
      await firstValueFrom(service.signMessage({ address: 'bc1p-ord', message: 'y', network: Network.Mainnet }));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain('User rejected');
  });

  // Finding #11 — the wallet's signMessage API might sign under a
  // different key than the caller asked for (Unisat / Leather take
  // no address parameter; they sign under whatever the wallet UI
  // currently has selected). Two gates catch the drift.

  describe('Finding #11 — address-drift protection', () => {

    it('pre-check: rejects when caller-requested address differs from the connected wallet', async () => {
      const service = newService();
      service['connectedWallet$'] = { getValue: () => wallet } as never;
      // Caller asks to sign under a DIFFERENT address than the one
      // the wallet is currently connected as (stale cache OR intended
      // fraud). Reject before the wallet sees the request.
      let caught: Error | null = null;
      try {
        await firstValueFrom(service.signMessage({
          address: 'bc1p-DIFFERENT',
          message: 'x',
          network: Network.Mainnet,
        }));
      } catch (e) {
        caught = e as Error;
      }
      expect(caught?.message).toContain('does not match');
      expect(caught?.message).toContain('bc1p-DIFFERENT');
      expect(caught?.message).toContain('bc1p-ord');
      // Signer was NOT dispatched — no wasted wallet round-trip.
      expect(mockSignMessage).not.toHaveBeenCalled();
      // Verify was NOT called either — the sig never came back.
      expect(mockVerifyBip322).not.toHaveBeenCalled();
    });

    it('post-verify: rejects when the returned sig does not verify against the caller-requested address', async () => {
      const service = newService();
      service['connectedWallet$'] = { getValue: () => wallet } as never;
      mockSignMessage.mockReturnValue(of({ signature: 'valid-looking-but-wrong-key' }));
      // Simulate: wallet SIGNED but with a different key than
      // args.address (user switched inside the wallet UI mid-request).
      mockVerifyBip322.mockReturnValue({ ok: false, reason: 'signature-does-not-verify' });

      let caught: Error | null = null;
      try {
        await firstValueFrom(service.signMessage({
          address: 'bc1p-ord',
          message: 'x',
          network: Network.Mainnet,
        }));
      } catch (e) {
        caught = e as Error;
      }
      expect(caught?.message).toContain('does not verify against bc1p-ord');
      expect(caught?.message).toContain('signature-does-not-verify');
      // Dispatch happened (pre-check passed); the failure was at
      // post-verify.
      expect(mockSignMessage).toHaveBeenCalledTimes(1);
      expect(mockVerifyBip322).toHaveBeenCalledTimes(1);
    });
  });
});
