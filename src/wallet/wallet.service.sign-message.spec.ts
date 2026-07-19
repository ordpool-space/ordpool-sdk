import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
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
  });

  it('errors with "No wallet connected" when no wallet is present', async () => {
    const service = newService();
    let caught: Error | null = null;
    try {
      await firstValueFrom(service.signMessage({ address: 'x', message: 'hi', network: Network.Mainnet }));
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
  });

  it('propagates a signer-side error observable', async () => {
    const service = newService();
    service['connectedWallet$'] = { getValue: () => wallet } as never;
    mockSignMessage.mockReturnValue(throwError(() => new Error('User rejected')));

    let caught: Error | null = null;
    try {
      await firstValueFrom(service.signMessage({ address: 'x', message: 'y', network: Network.Mainnet }));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain('User rejected');
  });
});
