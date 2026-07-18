import { describe, expect, it, jest } from '@jest/globals';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject, of } from 'rxjs';

import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { cat21Config } from '../cat21-mint/cat21-sdk-config';
import { makeWallet } from '../testing/fixtures';
import { Cat21AcceptOfferOrchestrator } from './cat21-accept-offer-orchestrator.service';

type MockWalletService = {
  connectedWallet$: BehaviorSubject<WalletInfo | null>;
};
type MockCat21Service = {
  postTransaction: jest.MockedFunction<Cat21Service['postTransaction']>;
  recommendedFees$: typeof Cat21Service.prototype.recommendedFees$;
};

const buildOrchestrator = (): {
  orchestrator: Cat21AcceptOfferOrchestrator;
  walletSubject: BehaviorSubject<WalletInfo | null>;
} => {
  const walletSubject = new BehaviorSubject<WalletInfo | null>(null);
  const cat21: MockCat21Service = {
    postTransaction: jest.fn(),
    recommendedFees$: new Subject<never>() as unknown as Cat21Service['recommendedFees$'],
  };
  const injector = Injector.create({
    providers: [
      { provide: WalletService, useValue: { connectedWallet$: walletSubject } satisfies MockWalletService },
      { provide: Cat21Service, useValue: cat21 },
      { provide: bitcoinNetwork, useValue: Network.Mainnet },
      { provide: cat21Config, useValue: { mempoolApiUrl: 'https://mempool.test', cat21ApiUrl: 'https://api.cat21.test' } },
      { provide: storage, useValue: { getValue: () => null, setValue: () => {}, removeItem: () => {} } },
    ],
  });
  const orchestrator = runInInjectionContext(injector, () => new Cat21AcceptOfferOrchestrator());
  return { orchestrator, walletSubject };
};

describe('Cat21AcceptOfferOrchestrator', () => {

  describe('paste decoding', () => {

    it('starts in idle with nothing pasted', () => {
      const { orchestrator } = buildOrchestrator();
      expect(orchestrator.state()).toBe('idle');
      expect(orchestrator.pastedOffer()).toBeNull();
      expect(orchestrator.parsedOffer()).toBeNull();
    });

    it('clearing the paste returns the orchestrator to idle', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setPastedOffer('cHNidPbroken');
      orchestrator.setPastedOffer(null);
      expect(orchestrator.state()).toBe('idle');
      expect(orchestrator.pastedOffer()).toBeNull();
      expect(orchestrator.parsedOffer()).toBeNull();
    });

    it('garbage paste transitions to invalid with a decode failure', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setExpectedCatUtxo({ txid: 'a'.repeat(64), vout: 0 });
      orchestrator.setPastedOffer('not-a-psbt');
      expect(orchestrator.state()).toBe('invalid');
      expect(orchestrator.validationResult()?.ok).toBe(false);
    });

    it('without an expectedCatUtxo the orchestrator stays in idle even with a valid-looking paste', () => {
      const { orchestrator } = buildOrchestrator();
      // The validator can't run without an expected cat — the orchestrator
      // must NOT mark the paste as parsed in this state.
      orchestrator.setPastedOffer('cHNidP8BAH0CAAAAAAAA'); // base64 prefix
      expect(orchestrator.state()).toBe('idle');
      expect(orchestrator.parsedOffer()).toBeNull();
    });
  });

  describe('writable setters re-run validation when a paste is in the box', () => {

    it('updating the floor price re-validates the paste', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setExpectedCatUtxo({ txid: 'a'.repeat(64), vout: 0 });
      orchestrator.setPastedOffer('not-a-psbt'); // will fail decode
      const beforeFloor = orchestrator.validationResult();
      orchestrator.setFloorPriceSats(10000);
      const afterFloor = orchestrator.validationResult();
      expect(beforeFloor).toBeTruthy();
      expect(afterFloor).toBeTruthy();
      expect(afterFloor?.ok).toBe(false); // still invalid (decode); but re-ran
    });

    it('a paste that decodes but has no expectedCat stays idle; setting all expected-* fields runs validation', () => {
      const { orchestrator } = buildOrchestrator();
      // Decode-succeeds-but-validate-fails paste (just enough magic bytes
      // to pass the sniff in `decodePastedPsbt`; will fail validation).
      orchestrator.setPastedOffer('cHNidP8BAA=='); // base64 of magic only
      expect(orchestrator.state()).toBe('idle');
      orchestrator.setExpectedCatUtxo({ txid: 'b'.repeat(64), vout: 0 });
      // Still idle — orchestrator demands floor + expected seller address before validating.
      expect(orchestrator.state()).toBe('idle');
      orchestrator.setFloorPriceSats(1);
      orchestrator.setExpectedSellerPaymentAddress('bc1qSellerExpected');
      // Now validation runs on the minimal PSBT shape → invalid.
      expect(orchestrator.state()).toBe('invalid');
    });
  });

  describe('acceptOffer() guards', () => {

    it('errors when no wallet is connected', async () => {
      const { orchestrator } = buildOrchestrator();
      let caught: Error | null = null;
      orchestrator.acceptOffer().subscribe({
        error: (e: Error) => { caught = e; },
      });
      expect(caught).not.toBeNull();
      expect((caught as unknown as Error).message).toContain('No wallet connected');
    });

    it('errors when no validated offer is in hand', async () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      walletSubject.next(makeWallet());
      let caught: Error | null = null;
      orchestrator.acceptOffer().subscribe({
        error: (e: Error) => { caught = e; },
      });
      expect(caught).not.toBeNull();
      expect((caught as unknown as Error).message).toContain('No validated offer');
    });
  });

  describe('reset()', () => {

    it('clears paste + parse + result back to idle', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setExpectedCatUtxo({ txid: 'a'.repeat(64), vout: 0 });
      orchestrator.setPastedOffer('not-a-psbt');
      orchestrator.setFloorPriceSats(50000);
      orchestrator.reset();
      expect(orchestrator.state()).toBe('idle');
      expect(orchestrator.pastedOffer()).toBeNull();
      expect(orchestrator.parsedOffer()).toBeNull();
      expect(orchestrator.validationResult()).toBeNull();
      expect(orchestrator.floorPriceSats()).toBeNull();
      expect(orchestrator.expectedCatUtxo()).toBeNull();
    });
  });
});
