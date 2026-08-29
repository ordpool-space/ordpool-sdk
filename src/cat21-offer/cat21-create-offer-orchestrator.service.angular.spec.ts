import { describe, expect, it, jest } from '@jest/globals';
import { Injector, runInInjectionContext } from '@angular/core';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { BehaviorSubject, Observable, Subject, combineLatest, firstValueFrom, map, of, throwError } from 'rxjs';

import { FundingRecommendationService } from '../cat21-fee/funding-recommendation.service';
import { recommendFunding } from '../cat21-fee/funding-safety';
import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { WalletService } from '../wallet/wallet.service';
import { KnownOrdinalWalletType, WalletInfo } from '../wallet/wallet.service.types';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { cat21Config } from '../cat21-mint/cat21-sdk-config';
import { RecommendedFees, TxnOutput } from '../cat21-mint/cat21.service.types';
import { toPaymentAddress } from '../wallet/address-types';
import { makeWallet } from '../testing/fixtures';
import {
  BuyOfferTargetCat,
  Cat21CreateOfferOrchestrator,
} from './cat21-create-offer-orchestrator.service';

// ---------------------------------------------------------------------------
// Real derived addresses so the simulation's inner PSBT build doesn't
// choke on invalid bech32 (which manifests as { insufficient: true } and
// hides what we're really testing). Pubkey is the well-known test key
// used across cat21-offer.helper.spec.ts.
// ---------------------------------------------------------------------------
const BUYER_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const SELLER_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000002');
const BUYER_P2WPKH = btc.p2wpkh(BUYER_KEY, btc.NETWORK);
const BUYER_P2TR = btc.p2tr(BUYER_KEY.slice(1, 33), undefined, btc.NETWORK);
const SELLER_P2WPKH = btc.p2wpkh(SELLER_KEY, btc.NETWORK);
const SELLER_P2TR = btc.p2tr(SELLER_KEY.slice(1, 33), undefined, btc.NETWORK);

const BUYER_PAYMENT = BUYER_P2WPKH.address!;
const BUYER_ORDINALS = BUYER_P2TR.address!;
const SELLER_PAYMENT = toPaymentAddress(SELLER_P2WPKH.address!);
const SELLER_CAT_SCRIPT = SELLER_P2TR.script; // seller's cat sits at a P2TR (typical)

const wallet = (over: Partial<WalletInfo> = {}): WalletInfo =>
  makeWallet({
    ordinalsAddress: BUYER_ORDINALS,
    ordinalsPublicKey: hex.encode(BUYER_KEY.slice(1, 33)),
    paymentAddress: BUYER_PAYMENT,
    paymentPublicKey: hex.encode(BUYER_KEY),
    ...over,
  });

const target = (over: Partial<BuyOfferTargetCat> = {}): BuyOfferTargetCat => ({
  catNumber: 42,
  txid: 'a'.repeat(64),
  vout: 0,
  value: 546,
  scriptPubKey: SELLER_CAT_SCRIPT,
  ...over,
});

const buildOrchestrator = (opts: {
  utxos?: TxnOutput[];
  utxosError?: Error;
  // Outpoints (`txid:vout`) to mark as asset-bearing so the recommendation
  // returns `expert-required` instead of `auto`. Everything else is clean.
  assetOutpoints?: Set<string>;
} = {}) => {
  const walletSubject = new BehaviorSubject<WalletInfo | null>(null);
  const cat21 = {
    getUtxos: jest.fn((_address: string) =>
      opts.utxosError
        ? throwError(() => opts.utxosError!)
        : of(opts.utxos ?? ([] as TxnOutput[])),
    ),
    recommendedFees$: new Subject<RecommendedFees>(),
  };
  // Scanner-free stand-in for FundingRecommendationService: marks the given
  // outpoints as asset-bearing (everything else clean), so `auto` vs
  // `expert-required` branching runs through the real orchestrator. Content
  // detection itself is proven in funding-recommendation.service.angular.spec.ts.
  const assetOutpoints = opts.assetOutpoints ?? new Set<string>();
  const fundingRec = {
    recommend: (
      utxos$: Observable<ReadonlyArray<{ txid: string; vout: number; value: number }>>,
      target$: Observable<number | null>,
    ) =>
      combineLatest([utxos$, target$]).pipe(
        map(([utxos, target]) => {
          if (!target || target <= 0 || utxos.length === 0) return recommendFunding([], target ?? 0);
          return recommendFunding(
            utxos.map((u) => ({
              ...u,
              bucket: assetOutpoints.has(`${u.txid}:${u.vout}`) ? ('assets' as const) : ('clean' as const),
            })),
            target,
          );
        }),
      ),
  } as unknown as FundingRecommendationService;
  const injector = Injector.create({
    providers: [
      { provide: WalletService, useValue: { connectedWallet$: walletSubject } },
      { provide: Cat21Service, useValue: cat21 },
      { provide: bitcoinNetwork, useValue: Network.Mainnet },
      { provide: cat21Config, useValue: { mempoolApiUrl: 'https://mempool.test', cat21ApiUrl: 'https://api.cat21.test' } },
      { provide: storage, useValue: { getValue: () => null, setValue: () => {}, removeItem: () => {} } },
      { provide: FundingRecommendationService, useValue: fundingRec },
    ],
  });
  const orchestrator = runInInjectionContext(injector, () => new Cat21CreateOfferOrchestrator());
  return { orchestrator, walletSubject, cat21 };
};

describe('Cat21CreateOfferOrchestrator', () => {

  describe('initial state', () => {
    it('starts in idle with no wallet', () => {
      const { orchestrator } = buildOrchestrator();
      expect(orchestrator.state()).toBe('idle');
      expect(orchestrator.targetCat()).toBeNull();
      expect(orchestrator.sellerPaymentAddress()).toBeNull();
      expect(orchestrator.priceSats()).toBeNull();
      expect(orchestrator.buyerReceiveAddress()).toBeNull();
      expect(orchestrator.feeRate()).toBeNull();
      expect(orchestrator.offerArtifact()).toBeNull();
    });

    it('when a wallet connects, buyerReceiveAddress defaults to the wallet ordinals address and state moves to ready', () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      walletSubject.next(wallet());
      expect(orchestrator.buyerReceiveAddress()).toBe(BUYER_ORDINALS);
      expect(orchestrator.state()).toBe('ready');
    });
  });

  describe('setters', () => {

    it('setSellerPaymentAddress persists a branded PaymentAddress and accepts null', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      expect(orchestrator.sellerPaymentAddress()).toBe(SELLER_PAYMENT);
      orchestrator.setSellerPaymentAddress(null);
      expect(orchestrator.sellerPaymentAddress()).toBeNull();
    });

    it('simulation$ re-emits when target / seller-payment / buyer-receive change (all drive the fee)', async () => {
      const fundingUtxo: TxnOutput = { txid: 'f'.repeat(64), vout: 0, value: 200_000, status: { confirmed: true } };
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos: [fundingUtxo] });
      walletSubject.next(wallet());
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(10);

      const emissions: unknown[] = [];
      const sub = orchestrator.simulation$.subscribe(v => emissions.push(v));
      await Promise.resolve();

      // Each of the three previously-missing sources must re-fire the stream.
      let count = emissions.length;
      expect(count).toBeGreaterThan(0);
      orchestrator.setTargetCat(target());
      expect(emissions.length).toBeGreaterThan(count); count = emissions.length;
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      expect(emissions.length).toBeGreaterThan(count); count = emissions.length;
      orchestrator.setBuyerReceiveAddress('bc1qbuyerreceive');
      expect(emissions.length).toBeGreaterThan(count);
      sub.unsubscribe();
    });

    it('toPaymentAddress upstream of the setter rejects garbage', () => {
      // Shape validation is the branded constructor's job; the setter
      // only sees well-formed values. Pinning the constructor's
      // rejection here documents the contract seam.
      expect(() => toPaymentAddress('   ')).toThrow();
      expect(() => toPaymentAddress('not-an-address')).toThrow();
      expect(() => toPaymentAddress('  ' + SELLER_PAYMENT + '  ')).toThrow();
    });

    it('setPriceSats floors + rejects non-positive/NaN', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setPriceSats(21_000.9);
      expect(orchestrator.priceSats()).toBe(21_000);

      orchestrator.setPriceSats(-1);
      expect(orchestrator.priceSats()).toBe(21_000); // unchanged
      orchestrator.setPriceSats(0);
      expect(orchestrator.priceSats()).toBe(21_000); // unchanged
      orchestrator.setPriceSats(Number.NaN);
      expect(orchestrator.priceSats()).toBe(21_000); // unchanged
    });

    it('setFeeRate rejects non-positive/NaN', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setFeeRate(5);
      expect(orchestrator.feeRate()).toBe(5);
      orchestrator.setFeeRate(-1);
      expect(orchestrator.feeRate()).toBe(5); // unchanged
      orchestrator.setFeeRate(Number.NaN);
      expect(orchestrator.feeRate()).toBe(5); // unchanged
    });
  });

  describe('wallet-swap reset', () => {

    it('swapping to a different ordinals address wipes form + resets buyerReceive to new wallet', () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      const A = wallet({ ordinalsAddress: 'bc1p-A-ordinals', paymentAddress: 'bc1q-A-payment' });
      const B = wallet({ ordinalsAddress: 'bc1p-B-ordinals', paymentAddress: 'bc1q-B-payment' });

      walletSubject.next(A);
      orchestrator.setTargetCat(target());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);
      expect(orchestrator.buyerReceiveAddress()).toBe('bc1p-A-ordinals');

      walletSubject.next(B);
      expect(orchestrator.targetCat()).toBeNull();
      expect(orchestrator.sellerPaymentAddress()).toBeNull();
      expect(orchestrator.priceSats()).toBeNull();
      expect(orchestrator.feeRate()).toBeNull();
      // buyerReceive re-anchors to B's ordinals address.
      expect(orchestrator.buyerReceiveAddress()).toBe('bc1p-B-ordinals');
    });

    it('re-emitting the same wallet is NOT a swap — form is preserved', () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      const A = wallet();
      walletSubject.next(A);
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);

      walletSubject.next(A);
      expect(orchestrator.sellerPaymentAddress()).toBe(SELLER_PAYMENT);
      expect(orchestrator.priceSats()).toBe(21_000);
    });

    it('disconnecting the wallet wipes form + defers buyerReceive to null', () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      walletSubject.next(wallet());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      walletSubject.next(null);
      expect(orchestrator.sellerPaymentAddress()).toBeNull();
      expect(orchestrator.priceSats()).toBeNull();
      expect(orchestrator.state()).toBe('idle');
    });
  });

  describe('simulation$ — insufficient fires when the buyer cannot cover the requirement', () => {

    it('a funding UTXO smaller than (price + fee + postage) emits { simulation: null, insufficient: true }', async () => {
      // 900-sat UTXO can't cover 21000 + fee + postages.
      const utxos: TxnOutput[] = [{
        txid: 'b'.repeat(64),
        vout: 0,
        value: 900,
        status: { confirmed: true, block_height: 800_000, block_hash: '', block_time: 0 },
      }];
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos });
      walletSubject.next(wallet());
      orchestrator.setTargetCat(target());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.insufficient).toBe(true);
      expect(outcome.simulation).toBeNull();
    });

    it('a large enough UTXO produces a simulation with change > 0', async () => {
      const utxos: TxnOutput[] = [{
        txid: 'b'.repeat(64),
        vout: 0,
        value: 100_000,
        status: { confirmed: true, block_height: 800_000, block_hash: '', block_time: 0 },
      }];
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos });
      walletSubject.next(wallet());
      orchestrator.setTargetCat(target());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.insufficient).toBe(false);
      expect(outcome.simulation).not.toBeNull();
      expect(outcome.simulation!.buyerFundingUtxo.value).toBe(100_000);
      expect(outcome.simulation!.changeSats).toBeGreaterThan(0);
      expect(outcome.simulation!.feeSats).toBeGreaterThan(0);
    });

    it('sizes the buyer funding to the cat UTXO value on a NON-546 cat (ord parity)', async () => {
      // Regression: the orchestrator must fund priceSats + the cat's REAL
      // UTXO value (output 0 goes to the buyer whole, ord parity) + fee, NOT
      // priceSats + 546 + fee. On a 9000-sat cat the buyer funds 8454 sats
      // more than on a 546-sat cat; a 546-hardcode would under-fund and the
      // builder would throw at sign time.
      const utxos: TxnOutput[] = [{
        txid: 'b'.repeat(64),
        vout: 0,
        value: 100_000,
        status: { confirmed: true, block_height: 800_000, block_hash: '', block_time: 0 },
      }];
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos });
      walletSubject.next(wallet());
      orchestrator.setTargetCat(target({ value: 9_000 }));
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.insufficient).toBe(false);
      expect(outcome.simulation).not.toBeNull();
      const sim = outcome.simulation!;
      // change + price + cat value (9000) + fee == funding: the buyer funds
      // the cat output at its REAL size, proving no 546 hardcode remains.
      expect(sim.changeSats + 21_000 + 9_000 + sim.feeSats).toBe(100_000);
    });

    it('form incomplete (no target) yields { simulation: null, insufficient: false }', async () => {
      const utxos: TxnOutput[] = [{
        txid: 'b'.repeat(64),
        vout: 0,
        value: 100_000,
        status: { confirmed: true, block_height: 800_000, block_hash: '', block_time: 0 },
      }];
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos });
      walletSubject.next(wallet());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);
      // targetCat still null.

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.insufficient).toBe(false);
      expect(outcome.simulation).toBeNull();
    });
  });

  describe('safe-auto coin selection (the vision)', () => {
    const coin = (txid: string, value: number): TxnOutput => ({
      txid: txid.repeat(64).slice(0, 64),
      vout: 0,
      value,
      status: { confirmed: true, block_height: 800_000, block_hash: '', block_time: 0 },
    });
    const armOffer = (orchestrator: Cat21CreateOfferOrchestrator, walletSubject: BehaviorSubject<WalletInfo | null>) => {
      walletSubject.next(wallet());
      orchestrator.setTargetCat(target());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);
    };

    it('AUTO (invisible default): a clean covering coin drives the simulation, no picker', async () => {
      const clean = coin('c', 100_000);
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos: [clean] });
      armOffer(orchestrator, walletSubject);

      const rec = await firstValueFrom(orchestrator.buyerFundingRecommendation$);
      expect(rec.status).toBe('auto');
      expect(rec.recommended?.txid).toBe(clean.txid);

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.insufficient).toBe(false);
      expect(outcome.simulation?.buyerFundingUtxo.txid).toBe(clean.txid);
    });

    it('EXPERT-REQUIRED: only an asset coin covers -> NO auto-pick (simulation null, NOT insufficient)', async () => {
      const assetCoin = coin('d', 100_000);
      const { orchestrator, walletSubject } = buildOrchestrator({
        utxos: [assetCoin],
        assetOutpoints: new Set([`${assetCoin.txid}:${assetCoin.vout}`]),
      });
      armOffer(orchestrator, walletSubject);

      const rec = await firstValueFrom(orchestrator.buyerFundingRecommendation$);
      expect(rec.status).toBe('expert-required');
      expect(rec.recommended?.bucket).toBe('assets');

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.simulation).toBeNull();
      expect(outcome.insufficient).toBe(false); // funds exist; they're just valuable
    });

    it('EXPERT OVERRIDE: an explicit pick of the asset coin is honoured', async () => {
      const assetCoin = coin('d', 100_000);
      const { orchestrator, walletSubject } = buildOrchestrator({
        utxos: [assetCoin],
        assetOutpoints: new Set([`${assetCoin.txid}:${assetCoin.vout}`]),
      });
      armOffer(orchestrator, walletSubject);
      orchestrator.setSelectedFundingUtxo(assetCoin);

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.insufficient).toBe(false);
      expect(outcome.simulation?.buyerFundingUtxo.txid).toBe(assetCoin.txid);
    });

    it('never auto-spends the tighter ASSET coin when a clean coin also covers', async () => {
      const assetTight = coin('d', 22_000); // tightest fit over (21000 + 546 + fee), but assets
      const cleanLoose = coin('c', 100_000);
      const { orchestrator, walletSubject } = buildOrchestrator({
        utxos: [assetTight, cleanLoose],
        assetOutpoints: new Set([`${assetTight.txid}:${assetTight.vout}`]),
      });
      armOffer(orchestrator, walletSubject);

      const rec = await firstValueFrom(orchestrator.buyerFundingRecommendation$);
      expect(rec.status).toBe('auto');
      expect(rec.recommended?.txid).toBe(cleanLoose.txid);

      const outcome = await firstValueFrom(orchestrator.simulation$);
      expect(outcome.simulation?.buyerFundingUtxo.txid).toBe(cleanLoose.txid);
    });
  });

  describe('createOffer() guards', () => {

    it('rejects when no wallet is connected', async () => {
      const { orchestrator } = buildOrchestrator();
      await expect(firstValueFrom(orchestrator.createOffer())).rejects.toThrow('No wallet connected');
    });

    it('rejects when target cat is missing', async () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      walletSubject.next(wallet());
      await expect(firstValueFrom(orchestrator.createOffer())).rejects.toThrow('No target cat');
    });

    it('rejects when seller payment address is missing (regression sentinel)', async () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      walletSubject.next(wallet());
      orchestrator.setTargetCat(target());
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);
      await expect(firstValueFrom(orchestrator.createOffer())).rejects.toThrow('No seller payment address');
    });

    it('rejects insufficient funds (the layer-2 fix) with the specific error message', async () => {
      const utxos: TxnOutput[] = [{
        txid: 'b'.repeat(64),
        vout: 0,
        value: 900, // won't cover 21k + fee + postages
        status: { confirmed: true, block_height: 800_000, block_hash: '', block_time: 0 },
      }];
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos });
      walletSubject.next(wallet());
      // Give the simulation$ a chance to load the funding-utxo snapshot.
      await firstValueFrom(orchestrator.simulation$);
      orchestrator.setTargetCat(target());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);
      // Re-await simulation with full inputs so the snapshot is up-to-date.
      await firstValueFrom(orchestrator.simulation$);

      await expect(firstValueFrom(orchestrator.createOffer())).rejects.toThrow('Insufficient funds');
      expect(orchestrator.state()).toBe('error');
    });
  });

  describe('createOffer() watch-only promptForSignedPsbt threading', () => {
    const fund = (): TxnOutput[] => [{
      txid: 'b'.repeat(64), vout: 0, value: 200_000,
      status: { confirmed: true, block_height: 800_000, block_hash: '', block_time: 0 },
    }];

    it('createOffer(prompt) threads the callback to the watch-only signer (it fires)', async () => {
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos: fund() });
      walletSubject.next(wallet({ type: KnownOrdinalWalletType.xpub }));
      await firstValueFrom(orchestrator.simulation$);
      orchestrator.setTargetCat(target());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);
      await firstValueFrom(orchestrator.simulation$);

      const prompt = jest.fn((u: { base64: string; hex: string }) => of(u.base64));
      await firstValueFrom(orchestrator.createOffer(prompt)).catch(() => undefined);
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it('a watch-only offer-create WITHOUT the callback errors on the missing bridge', async () => {
      const { orchestrator, walletSubject } = buildOrchestrator({ utxos: fund() });
      walletSubject.next(wallet({ type: KnownOrdinalWalletType.xpub }));
      await firstValueFrom(orchestrator.simulation$);
      orchestrator.setTargetCat(target());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);
      await firstValueFrom(orchestrator.simulation$);

      await expect(firstValueFrom(orchestrator.createOffer())).rejects.toThrow(/promptForSignedPsbt/);
    });
  });

  describe('reset()', () => {

    it('clears form, restores buyerReceive to connected wallet, returns to ready', () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      walletSubject.next(wallet());
      orchestrator.setTargetCat(target());
      orchestrator.setSellerPaymentAddress(SELLER_PAYMENT);
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);

      orchestrator.reset();

      expect(orchestrator.targetCat()).toBeNull();
      expect(orchestrator.sellerPaymentAddress()).toBeNull();
      expect(orchestrator.priceSats()).toBeNull();
      expect(orchestrator.feeRate()).toBeNull();
      expect(orchestrator.buyerReceiveAddress()).toBe(BUYER_ORDINALS);
      expect(orchestrator.state()).toBe('ready');
    });

    it('with no wallet connected, reset lands in idle', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.reset();
      expect(orchestrator.state()).toBe('idle');
    });
  });

  describe('buyerFundingUtxos$', () => {

    it('empty when no wallet is connected', async () => {
      const { orchestrator } = buildOrchestrator();
      const utxos = await firstValueFrom(orchestrator.buyerFundingUtxos$);
      expect(utxos).toEqual([]);
      expect(orchestrator.state()).toBe('idle');
    });

    it('loads UTXOs from the wallet paymentAddress once a wallet connects', async () => {
      const utxos: TxnOutput[] = [{
        txid: 'c'.repeat(64),
        vout: 1,
        value: 50_000,
        status: { confirmed: true, block_height: 800_000, block_hash: '', block_time: 0 },
      }];
      const { orchestrator, walletSubject, cat21 } = buildOrchestrator({ utxos });
      walletSubject.next(wallet());
      const result = await firstValueFrom(orchestrator.buyerFundingUtxos$);
      expect(result).toEqual(utxos);
      expect(cat21.getUtxos).toHaveBeenCalledWith(BUYER_PAYMENT);
      expect(orchestrator.state()).toBe('ready');
    });

    it('surfaces a fetch error into state=error with a descriptive message', async () => {
      const { orchestrator, walletSubject } = buildOrchestrator({
        utxosError: new Error('electrs is down'),
      });
      walletSubject.next(wallet());
      await firstValueFrom(orchestrator.buyerFundingUtxos$);
      expect(orchestrator.state()).toBe('error');
      expect(orchestrator.errorMessage()).toContain('electrs is down');
    });
  });
});
