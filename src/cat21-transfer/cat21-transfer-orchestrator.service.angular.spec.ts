import { describe, expect, it, jest } from '@jest/globals';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject, firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { WalletService } from '../wallet/wallet.service';
import { KnownOrdinalWalletType, WalletInfo } from '../wallet/wallet.service.types';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { cat21Config } from '../cat21-mint/cat21-sdk-config';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Cat21Holding, Cat21TransferOrchestrator } from './cat21-transfer-orchestrator.service';

const wallet = (overrides: Partial<WalletInfo> = {}): WalletInfo => ({
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: 'bc1ptrrx4duc8afs4ye63xgcyf6d7kg29a4myay4nqxmd04zx8j9jers899d0x',
  ordinalsPublicKey: '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37',
  paymentAddress: 'bc1qexample',
  paymentPublicKey: '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b',
  signingSupported: true,
  ...overrides,
});

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

  const injector = Injector.create({
    providers: [
      { provide: WalletService, useValue: { connectedWallet$: walletSubject } satisfies MockWalletService },
      { provide: Cat21Service, useValue: cat21 },
      { provide: bitcoinNetwork, useValue: Network.Mainnet },
      { provide: cat21Config, useValue: { mempoolApiUrl: 'https://mempool.test', cat21ApiUrl: 'https://api.cat21.test' } },
      { provide: storage, useValue: { getValue: () => null, setValue: () => {}, removeItem: () => {} } },
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
});
