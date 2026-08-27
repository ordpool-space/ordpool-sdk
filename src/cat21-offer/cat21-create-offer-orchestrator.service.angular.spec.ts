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
