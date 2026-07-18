import { describe, expect, it, jest } from '@jest/globals';
import { Injector, runInInjectionContext } from '@angular/core';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { BehaviorSubject, Subject, firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { WalletService } from '../wallet/wallet.service';
import { KnownOrdinalWalletType, WalletInfo } from '../wallet/wallet.service.types';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { cat21Config } from '../cat21-mint/cat21-sdk-config';
import { RecommendedFees, TxnOutput } from '../cat21-mint/cat21.service.types';
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
const PUBKEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const XONLY = PUBKEY.slice(1, 33);
const P2WPKH = btc.p2wpkh(PUBKEY, btc.NETWORK);
const P2TR = btc.p2tr(XONLY, undefined, btc.NETWORK);

const BUYER_PAYMENT = P2WPKH.address!;
const BUYER_ORDINALS = P2TR.address!;
const SELLER_PAYMENT = P2WPKH.address!; // same shape; distinctness comes at the wallet-object level
const SELLER_CAT_SCRIPT = P2TR.script;   // seller's cat sits at a P2TR (typical)

const wallet = (over: Partial<WalletInfo> = {}): WalletInfo => ({
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: BUYER_ORDINALS,
  ordinalsPublicKey: hex.encode(XONLY),
  paymentAddress: BUYER_PAYMENT,
  paymentPublicKey: hex.encode(PUBKEY),
  signingSupported: true,
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

type MockCat21Service = {
  getUtxos: jest.MockedFunction<Cat21Service['getUtxos']>;
  recommendedFees$: Cat21Service['recommendedFees$'];
};

const buildOrchestrator = (opts: {
  utxos?: TxnOutput[];
  utxosError?: Error;
} = {}) => {
  const walletSubject = new BehaviorSubject<WalletInfo | null>(null);
  const cat21: MockCat21Service = {
    getUtxos: jest.fn(() =>
      opts.utxosError
        ? throwError(() => opts.utxosError!)
        : of(opts.utxos ?? ([] as TxnOutput[])),
    ),
    recommendedFees$: new Subject<RecommendedFees>() as unknown as Cat21Service['recommendedFees$'],
  };
  const injector = Injector.create({
    providers: [
      { provide: WalletService, useValue: { connectedWallet$: walletSubject } },
      { provide: Cat21Service, useValue: cat21 },
      { provide: bitcoinNetwork, useValue: Network.Mainnet },
      { provide: cat21Config, useValue: { mempoolApiUrl: 'https://mempool.test', cat21ApiUrl: 'https://api.cat21.test' } },
      { provide: storage, useValue: { getValue: () => null, setValue: () => {}, removeItem: () => {} } },
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

    it('setSellerPaymentAddress trims + rejects empty/whitespace', () => {
      const { orchestrator } = buildOrchestrator();
      orchestrator.setSellerPaymentAddress('  ' + SELLER_PAYMENT + '  ');
      expect(orchestrator.sellerPaymentAddress()).toBe(SELLER_PAYMENT);

      orchestrator.setSellerPaymentAddress('   ');
      expect(orchestrator.sellerPaymentAddress()).toBeNull();

      orchestrator.setSellerPaymentAddress(null);
      expect(orchestrator.sellerPaymentAddress()).toBeNull();
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

  describe('createOffer() guards', () => {
    it('rejects when no wallet is connected', async () => {
      const { orchestrator } = buildOrchestrator();
      let caught: Error | null = null;
      orchestrator.createOffer().subscribe({
        error: (e: Error) => { caught = e; },
      });
      expect(caught).not.toBeNull();
      expect((caught as unknown as Error).message).toContain('No wallet connected');
    });

    it('rejects when target cat is missing', async () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      walletSubject.next(wallet());
      let caught: Error | null = null;
      orchestrator.createOffer().subscribe({
        error: (e: Error) => { caught = e; },
      });
      expect(caught).not.toBeNull();
      expect((caught as unknown as Error).message).toContain('No target cat');
    });

    it('rejects when seller payment address is missing (regression sentinel)', async () => {
      const { orchestrator, walletSubject } = buildOrchestrator();
      walletSubject.next(wallet());
      orchestrator.setTargetCat(target());
      orchestrator.setPriceSats(21_000);
      orchestrator.setFeeRate(5);
      let caught: Error | null = null;
      orchestrator.createOffer().subscribe({
        error: (e: Error) => { caught = e; },
      });
      expect(caught).not.toBeNull();
      expect((caught as unknown as Error).message).toContain('No seller payment address');
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

      let caught: Error | null = null;
      orchestrator.createOffer().subscribe({
        error: (e: Error) => { caught = e; },
      });
      expect(caught).not.toBeNull();
      expect((caught as unknown as Error).message).toContain('Insufficient funds');
      expect(orchestrator.state()).toBe('error');
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
