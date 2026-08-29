import { describe, expect, it, jest } from '@jest/globals';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Observable, Subject, combineLatest, firstValueFrom, map, of, throwError } from 'rxjs';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { FundingRecommendationService } from '../cat21-fee/funding-recommendation.service';
import { recommendFunding } from '../cat21-fee/funding-safety';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { cat21Config } from '../cat21-mint/cat21-sdk-config';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { makeWallet } from '../testing/fixtures';
import { Cat21Holding, Cat21TransferOrchestrator } from './cat21-transfer-orchestrator.service';

const wallet = makeWallet;

const utxo = (overrides: Partial<TxnOutput> = {}): TxnOutput => ({
  txid: 'b'.repeat(64),
  vout: 1,
  value: 50_000,
  status: { confirmed: true },
  ...overrides,
});

const cat = (overrides: Partial<Cat21Holding> = {}): Cat21Holding => ({
  catNumber: 42,
  txid: 'a'.repeat(64),
  vout: 0,
  value: CAT21_POSTAGE_SATS,
  ...overrides,
});

type MockWalletService = {
  connectedWallet$: BehaviorSubject<WalletInfo | null>;
};

type MockCat21Service = {
  getUtxos: jest.MockedFunction<Cat21Service['getUtxos']>;
  postTransaction: jest.MockedFunction<Cat21Service['postTransaction']>;
  recommendedFees$: typeof Cat21Service.prototype.recommendedFees$;
};

const buildOrchestrator = (): {
  orchestrator: Cat21TransferOrchestrator;
  walletSubject: BehaviorSubject<WalletInfo | null>;
  cat21: MockCat21Service;
} => {
  const walletSubject = new BehaviorSubject<WalletInfo | null>(null);
  const cat21: MockCat21Service = {
    getUtxos: jest.fn(),
    postTransaction: jest.fn(),
    recommendedFees$: new Subject<never>() as unknown as Cat21Service['recommendedFees$'],
  };

  // Scanner-free stand-in for FundingRecommendationService: treats every funding
  // UTXO as content-clean, so the recommendation is always `auto` with the
  // best-fit clean coin (= smallest covering — ord's policy, the previous
  // auto-pick). The content-safety branching (auto vs expert-required vs
  // scanning) is proven in funding-recommendation.service.angular.spec.ts and
  // funding-safety.spec.ts; here we only need a deterministic auto-pick to drive
  // the transfer simulation.
  const fundingRec = {
    recommend: (
      utxos$: Observable<ReadonlyArray<{ txid: string; vout: number; value: number }>>,
      target$: Observable<number | null>,
    ) =>
      combineLatest([utxos$, target$]).pipe(
        map(([utxos, target]) =>
          recommendFunding(
            utxos.map((u) => ({ ...u, bucket: 'clean' as const })),
            target ?? 0,
          ),
        ),
      ),
  } as unknown as FundingRecommendationService;

  const injector = Injector.create({
    providers: [
      { provide: WalletService, useValue: { connectedWallet$: walletSubject } satisfies MockWalletService },
      { provide: Cat21Service, useValue: cat21 },
      { provide: bitcoinNetwork, useValue: Network.Mainnet },
      { provide: cat21Config, useValue: { mempoolApiUrl: 'https://mempool.test', cat21ApiUrl: 'https://api.cat21.test' } },
      { provide: storage, useValue: { getValue: () => null, setValue: () => {}, removeItem: () => {} } },
      { provide: FundingRecommendationService, useValue: fundingRec },
    ],
  });

  const orchestrator = runInInjectionContext(injector, () => new Cat21TransferOrchestrator());
  return { orchestrator, walletSubject, cat21 };
};

describe('Cat21TransferOrchestrator', () => {

  describe('state machine wiring', () => {

    it('starts in idle with no wallet connected', () => {
      const { orchestrator } = buildOrchestrator();
      expect(orchestrator.state()).toBe('idle');
      expect(orchestrator.catUtxo()).toBeNull();
      expect(orchestrator.recipientAddress()).toBeNull();
      expect(orchestrator.feeRate()).toBeNull();
    });

    it('transitions idle → loading-utxos → ready when a wallet connects and UTXOs arrive', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      cat21.getUtxos.mockReturnValue(of([utxo()]));

      walletSubject.next(wallet());
      const utxos = await firstValueFrom(orchestrator.fundingUtxos$);

      expect(utxos).toHaveLength(1);
      expect(orchestrator.state()).toBe('ready');
    });

    it('filters out the cat-bearing UTXO from the funding-UTXO stream', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      const catU = utxo({ txid: cat().txid, vout: cat().vout, value: CAT21_POSTAGE_SATS });
      const fundingU = utxo({ txid: 'c'.repeat(64), vout: 2, value: 50_000 });
      cat21.getUtxos.mockReturnValue(of([catU, fundingU]));

      orchestrator.setCatUtxo(cat());
      walletSubject.next(wallet());

      const utxos = await firstValueFrom(orchestrator.fundingUtxos$);
      expect(utxos).toEqual([fundingU]);
    });

    it('returns the error state and message when UTXO loading fails', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      cat21.getUtxos.mockReturnValue(throwError(() => new Error('electrs offline')));

      walletSubject.next(wallet());
      await firstValueFrom(orchestrator.fundingUtxos$);

      expect(orchestrator.state()).toBe('error');
      expect(orchestrator.errorMessage()).toContain('electrs offline');
    });
  });

  describe('writable inputs + auto-reset on wallet change', () => {

    it('exposes setRecipientAddress / setFeeRate / setCatUtxo setters that mutate the signals', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setCatUtxo(cat());
      orchestrator.setRecipientAddress('bc1qrecipient');
      orchestrator.setFeeRate(5);
      expect(orchestrator.catUtxo()?.catNumber).toBe(42);
      expect(orchestrator.recipientAddress()).toBe('bc1qrecipient');
      expect(orchestrator.feeRate()).toBe(5);
    });

    it('simulation$ re-emits when the recipient changes (recipient script type drives the fee)', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      cat21.getUtxos.mockReturnValue(of([utxo()]));
      walletSubject.next(wallet());
      orchestrator.setCatUtxo(cat());
      orchestrator.setFeeRate(10);

      const emissions: unknown[] = [];
      const sub = orchestrator.simulation$.subscribe(v => emissions.push(v));
      await Promise.resolve();
      const before = emissions.length;
      expect(before).toBeGreaterThan(0); // combineLatest is live

      // Changing ONLY the recipient must re-fire the stream. Before the fix
      // recipientAddress was not a combineLatest source, so this stayed put.
      orchestrator.setRecipientAddress('bc1qdifferentrecipient');
      expect(emissions.length).toBeGreaterThan(before);
      sub.unsubscribe();
    });

    it('clears writables when the wallet flips to a different ordinals address', () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      cat21.getUtxos.mockReturnValue(of([utxo()]));

      walletSubject.next(wallet());
      orchestrator.setCatUtxo(cat());
      orchestrator.setRecipientAddress('bc1qrecipient');
      orchestrator.setFeeRate(5);
      expect(orchestrator.feeRate()).toBe(5);

      walletSubject.next(wallet({ ordinalsAddress: 'bc1ptotallydifferentordinalsaddress' }));
      expect(orchestrator.catUtxo()).toBeNull();
      expect(orchestrator.recipientAddress()).toBeNull();
      expect(orchestrator.feeRate()).toBeNull();
    });

    it('rejects non-positive fee rates silently (no signal mutation)', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setFeeRate(5);
      orchestrator.setFeeRate(0);
      orchestrator.setFeeRate(-3);
      orchestrator.setFeeRate(Number.NaN);
      orchestrator.setFeeRate(Number.POSITIVE_INFINITY);
      expect(orchestrator.feeRate()).toBe(5);
    });

    it('normalises blank / whitespace recipient input to null', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setRecipientAddress('bc1qrecipient');
      orchestrator.setRecipientAddress('   ');
      expect(orchestrator.recipientAddress()).toBeNull();
      orchestrator.setRecipientAddress('  bc1qtrim   ');
      expect(orchestrator.recipientAddress()).toBe('bc1qtrim');
    });
  });

  describe('transfer() guards', () => {

    it('errors when no wallet is connected', async () => {
      const { orchestrator } = buildOrchestrator();
      await expect(firstValueFrom(orchestrator.transfer())).rejects.toThrow('No wallet connected');
    });

    it('errors when no cat is selected', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      cat21.getUtxos.mockReturnValue(of([utxo()]));
      walletSubject.next(wallet());
      await expect(firstValueFrom(orchestrator.transfer())).rejects.toThrow('No cat selected');
    });

    it('errors when no recipient address is provided', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      cat21.getUtxos.mockReturnValue(of([utxo()]));
      walletSubject.next(wallet());
      orchestrator.setCatUtxo(cat());
      await expect(firstValueFrom(orchestrator.transfer())).rejects.toThrow('No recipient address');
    });

    it('errors when no fee rate is set', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      cat21.getUtxos.mockReturnValue(of([utxo()]));
      walletSubject.next(wallet());
      orchestrator.setCatUtxo(cat());
      orchestrator.setRecipientAddress('bc1qrecipient');
      await expect(firstValueFrom(orchestrator.transfer())).rejects.toThrow('No fee rate set');
    });
  });

  describe('transfer() watch-only promptForSignedPsbt threading', () => {
    // A real P2WPKH payment address so buildTransferPsbt can derive the
    // funding input; the default fixture's ordinals address is already a
    // valid taproot address (used as the self-recipient here).
    const payAddr = btc.p2wpkh(
      hex.decode('0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b'),
      btc.NETWORK,
    ).address!;

    it('transfer(prompt) threads the callback to the watch-only signer (it fires)', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      const w = wallet({ type: KnownOrdinalWalletType.xpub, paymentAddress: payAddr });
      cat21.getUtxos.mockReturnValue(of([utxo({ value: 100_000 })]));
      walletSubject.next(w);
      orchestrator.setCatUtxo(cat());
      orchestrator.setRecipientAddress(w.ordinalsAddress); // valid taproot recipient
      orchestrator.setFeeRate(10);

      const prompt = jest.fn((u: { base64: string; hex: string }) => of(u.base64));
      // finalize/broadcast may fail after the callback; the threading is
      // proven the moment the orchestrator invokes it.
      await firstValueFrom(orchestrator.transfer(prompt)).catch(() => undefined);
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it('a watch-only transfer WITHOUT the callback errors on the missing bridge', async () => {
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
      const w = wallet({ type: KnownOrdinalWalletType.xpub, paymentAddress: payAddr });
      cat21.getUtxos.mockReturnValue(of([utxo({ value: 100_000 })]));
      walletSubject.next(w);
      orchestrator.setCatUtxo(cat());
      orchestrator.setRecipientAddress(w.ordinalsAddress);
      orchestrator.setFeeRate(10);

      await expect(firstValueFrom(orchestrator.transfer())).rejects.toThrow(/promptForSignedPsbt/);
    });
  });

  describe('safe-auto coin selection (the vision)', () => {
    // A real P2WPKH payment address (matches the fixture's paymentPublicKey) so
    // the simulation can build a real funding input. The default fixture's
    // `bc1qexample` is intentionally un-buildable.
    const payAddr = btc.p2wpkh(
      hex.decode('0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b'),
      btc.NETWORK,
    ).address!;
    const op = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

    // Orchestrator whose recommendation marks the given outpoints as
    // asset-bearing (everything else clean), so we can drive the real
    // auto / expert-required branching through the orchestrator.
    const buildWithAssets = (
      assetOutpoints: Set<string>,
    ): {
      orchestrator: Cat21TransferOrchestrator;
      walletSubject: BehaviorSubject<WalletInfo | null>;
      cat21: MockCat21Service;
    } => {
      const walletSubject = new BehaviorSubject<WalletInfo | null>(null);
      const cat21: MockCat21Service = {
        getUtxos: jest.fn(),
        postTransaction: jest.fn(),
        recommendedFees$: new Subject<never>() as unknown as Cat21Service['recommendedFees$'],
      };
      const fundingRec = {
        recommend: (
          utxos$: Observable<ReadonlyArray<{ txid: string; vout: number; value: number }>>,
          target$: Observable<number | null>,
        ) =>
          combineLatest([utxos$, target$]).pipe(
            map(([utxos, target]) =>
              recommendFunding(
                utxos.map((u) => ({
                  ...u,
                  bucket: assetOutpoints.has(op(u)) ? ('assets' as const) : ('clean' as const),
                })),
                target ?? 0,
              ),
            ),
          ),
      } as unknown as FundingRecommendationService;
      const injector = Injector.create({
        providers: [
          { provide: WalletService, useValue: { connectedWallet$: walletSubject } satisfies MockWalletService },
          { provide: Cat21Service, useValue: cat21 },
          { provide: bitcoinNetwork, useValue: Network.Mainnet },
          { provide: cat21Config, useValue: { mempoolApiUrl: 'https://mempool.test', cat21ApiUrl: 'https://api.cat21.test' } },
          { provide: storage, useValue: { getValue: () => null, setValue: () => {}, removeItem: () => {} } },
          { provide: FundingRecommendationService, useValue: fundingRec },
        ],
      });
      const orchestrator = runInInjectionContext(injector, () => new Cat21TransferOrchestrator());
      return { orchestrator, walletSubject, cat21 };
    };

    const arm = (
      orchestrator: Cat21TransferOrchestrator,
      walletSubject: BehaviorSubject<WalletInfo | null>,
      cat21: MockCat21Service,
      fundingUtxos: TxnOutput[],
    ): WalletInfo => {
      const w = wallet({ paymentAddress: payAddr });
      cat21.getUtxos.mockReturnValue(of(fundingUtxos));
      walletSubject.next(w);
      orchestrator.setCatUtxo(cat());
      orchestrator.setRecipientAddress(w.ordinalsAddress); // valid taproot recipient
      orchestrator.setFeeRate(10);
      return w;
    };

    it('AUTO (invisible default): a clean covering coin drives the simulation, no picker', async () => {
      const clean = utxo({ txid: 'c'.repeat(64), vout: 0, value: 100_000 });
      const { orchestrator, walletSubject, cat21 } = buildWithAssets(new Set());
      arm(orchestrator, walletSubject, cat21, [clean]);

      const rec = await firstValueFrom(orchestrator.fundingRecommendation$);
      expect(rec.status).toBe('auto');
      expect(rec.recommended?.txid).toBe(clean.txid);

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.insufficient).toBe(false);
      expect(outcome.simulation).not.toBeNull();
      expect(outcome.simulation?.fundingUtxo.txid).toBe(clean.txid);
    });

    it('EXPERT-REQUIRED: only an asset coin covers -> NO auto-pick (simulation null, NOT insufficient)', async () => {
      const assetCoin = utxo({ txid: 'd'.repeat(64), vout: 0, value: 100_000 });
      const { orchestrator, walletSubject, cat21 } = buildWithAssets(new Set([op(assetCoin)]));
      arm(orchestrator, walletSubject, cat21, [assetCoin]);

      const rec = await firstValueFrom(orchestrator.fundingRecommendation$);
      expect(rec.status).toBe('expert-required');
      expect(rec.recommended?.txid).toBe(assetCoin.txid);
      expect(rec.recommended?.bucket).toBe('assets');

      const outcome = await firstValueFrom(orchestrator.simulation$);
      // The funds exist but they're valuable — never auto-spent. No simulation,
      // but NOT "insufficient": the UI must surface the picker and ask.
      expect(outcome.simulation).toBeNull();
      expect(outcome.insufficient).toBe(false);
    });

    it('EXPERT OVERRIDE: an explicit pick of the asset coin is honoured (the user chose it)', async () => {
      const assetCoin = utxo({ txid: 'd'.repeat(64), vout: 0, value: 100_000 });
      const { orchestrator, walletSubject, cat21 } = buildWithAssets(new Set([op(assetCoin)]));
      arm(orchestrator, walletSubject, cat21, [assetCoin]);
      orchestrator.setSelectedFundingUtxo(assetCoin);

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.insufficient).toBe(false);
      expect(outcome.simulation).not.toBeNull();
      expect(outcome.simulation?.fundingUtxo.txid).toBe(assetCoin.txid);
    });

    it('never auto-spends the tighter ASSET coin when a clean coin also covers', async () => {
      const assetTight = utxo({ txid: 'd'.repeat(64), vout: 0, value: 3_000 }); // tightest fit, but assets
      const cleanLoose = utxo({ txid: 'c'.repeat(64), vout: 0, value: 100_000 });
      const { orchestrator, walletSubject, cat21 } = buildWithAssets(new Set([op(assetTight)]));
      arm(orchestrator, walletSubject, cat21, [assetTight, cleanLoose]);

      const rec = await firstValueFrom(orchestrator.fundingRecommendation$);
      expect(rec.status).toBe('auto');
      expect(rec.recommended?.txid).toBe(cleanLoose.txid); // the clean one, not the tighter asset

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.simulation?.fundingUtxo.txid).toBe(cleanLoose.txid);
    });
  });
});
