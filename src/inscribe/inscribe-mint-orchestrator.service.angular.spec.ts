import { describe, expect, it, jest } from '@jest/globals';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject, firstValueFrom, of, throwError } from 'rxjs';

import { Cat21Service } from '../cat21-mint/cat21.service';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { cat21Config } from '../cat21-mint/cat21-sdk-config';
import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';
import { makeXverseWallet } from '../testing/fixtures';

import {
  InscribeContent,
  InscribeMintOrchestrator,
} from './inscribe-mint-orchestrator.service';
import { InscribeAndBroadcastResult } from './inscribe-orchestrator';

// Wallet-swap tests below re-assert on this specific payment address,
// so the fixture bakes it in as the default.
const wallet = (overrides: Partial<WalletInfo> = {}): WalletInfo =>
  makeXverseWallet({ paymentAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', ...overrides });

const utxo = (overrides: Partial<TxnOutput> = {}): TxnOutput => ({
  txid: 'a'.repeat(64),
  vout: 0,
  value: 200_000,
  status: { confirmed: true },
  ...overrides,
});

const content = (overrides: Partial<InscribeContent> = {}): InscribeContent => ({
  body: new TextEncoder().encode('<html><!--cubes.haushoppe.art--></html>'),
  contentType: 'text/html;charset=utf-8',
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
  orchestrator: InscribeMintOrchestrator;
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

  const orchestrator = runInInjectionContext(injector, () => new InscribeMintOrchestrator());
  return { orchestrator, walletSubject, cat21 };
};


describe('InscribeMintOrchestrator — state machine', () => {

  it('starts idle with no wallet connected', () => {
    const { orchestrator } = buildOrchestrator();
    expect(orchestrator.state()).toBe('idle');
    expect(orchestrator.connectedWallet()).toBeNull();
  });

  it('transitions loading-utxos -> ready when a wallet connects and UTXOs load', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));

    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();

    expect(orchestrator.state()).toBe('ready');
    utxoSub.unsubscribe();
  });

  it('transitions back to idle when the wallet disconnects', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();
    expect(orchestrator.state()).toBe('ready');

    walletSubject.next(null);
    await Promise.resolve();
    expect(orchestrator.state()).toBe('idle');
    utxoSub.unsubscribe();
  });

  it('falls into error state when getUtxos fails', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(throwError(() => new Error('electrs is down')));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();

    expect(orchestrator.state()).toBe('error');
    expect(orchestrator.errorMessage()).toBe('Failed to load UTXOs: electrs is down');
    utxoSub.unsubscribe();
  });
});


describe('InscribeMintOrchestrator — simulations$', () => {

  it('emits [] when content is not set (fee + utxos alone are not enough)', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();
    orchestrator.setFeeRate(10);

    const rows = await firstValueFrom(orchestrator.simulations$);
    expect(rows).toEqual([]);
    utxoSub.unsubscribe();
  });

  it('produces one InscribeUtxoSimulation per UTXO once content + feeRate are set', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo({ value: 200_000 }), utxo({ txid: 'b'.repeat(64), value: 150_000 })]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();

    orchestrator.setFeeRate(5);
    orchestrator.setContent(content());

    const rows = await firstValueFrom(orchestrator.simulations$);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.simulation).toBeTruthy();
    expect(rows[0]?.simulation?.totalFeeSats).toBeGreaterThan(0);
    expect(rows[0]?.simulation?.fundingRequirementSats).toBeGreaterThan(0);
    utxoSub.unsubscribe();
  });

  it('flags UTXOs whose value is below fundingRequirementSats as insufficient', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    // Postage 546 + reveal-fee + commit-fee at rate 100 sat/vB against
    // a body of ~8000 bytes is comfortably above 3000 sats. Pin the tiny
    // UTXO as insufficient.
    cat21.getUtxos.mockReturnValue(of([utxo({ value: 3_000 })]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();

    orchestrator.setFeeRate(100);
    orchestrator.setContent(content({ body: new Uint8Array(8000).fill(0x41) }));

    const rows = await firstValueFrom(orchestrator.simulations$);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.insufficient).toBe(true);
    utxoSub.unsubscribe();
  });
});


describe('InscribeMintOrchestrator — auto-reset on wallet change', () => {

  it('clears feeRate + selectedUtxo + content + success/error when a different wallet connects', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();

    walletSubject.next(wallet({ ordinalsAddress: 'bc1pold-ordinals', paymentAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }));
    await Promise.resolve();

    orchestrator.setFeeRate(7);
    orchestrator.setSelectedUtxo(utxo({ txid: 'b'.repeat(64) }));
    orchestrator.setContent(content());
    orchestrator['errorMessage'].set('something broke');
    orchestrator['successResult'].set({ commitTxId: 'past' } as InscribeAndBroadcastResult);

    walletSubject.next(wallet({ ordinalsAddress: 'bc1pnew-ordinals', paymentAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }));
    await Promise.resolve();

    expect(orchestrator.feeRate()).toBeNull();
    expect(orchestrator.selectedUtxo()).toBeNull();
    expect(orchestrator.content()).toBeNull();
    expect(orchestrator.errorMessage()).toBeNull();
    expect(orchestrator.successResult()).toBeNull();
    utxoSub.unsubscribe();
  });

  it('keeps form state intact when the SAME wallet re-emits (BehaviorSubject replay)', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();

    const w = wallet();
    walletSubject.next(w);
    await Promise.resolve();

    orchestrator.setFeeRate(7);
    orchestrator.setContent(content());

    walletSubject.next(w);
    await Promise.resolve();

    expect(orchestrator.feeRate()).toBe(7);
    expect(orchestrator.content()).not.toBeNull();
    utxoSub.unsubscribe();
  });
});


describe('InscribeMintOrchestrator — mint() guards', () => {

  it('errors when no wallet connected', async () => {
    const { orchestrator } = buildOrchestrator();
    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow('No wallet connected');
  });

  it('errors when no fee rate set', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();

    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow('No fee rate set');
    utxoSub.unsubscribe();
  });

  it('errors when no UTXO selected', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();
    orchestrator.setFeeRate(5);

    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow('No UTXO selected');
    utxoSub.unsubscribe();
  });

  it('errors when no content set', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();
    orchestrator.setFeeRate(5);
    orchestrator.setSelectedUtxo(utxo());

    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow('No inscription content set');
    utxoSub.unsubscribe();
  });
});


describe('InscribeMintOrchestrator — InscribeContent carries the first-class envelope tags', () => {

  // mint() forwards each content field to inscribeAndBroadcast (proven
  // end-to-end in inscribe-orchestrator.spec.ts). Here we pin that the
  // InscribeContent surface accepts all first-class tags and the
  // orchestrator preserves them verbatim on the content signal — so a
  // consumer wiring pointer / metadata / delegate / rune / properties
  // reaches the forwarding call with those exact values.
  it('setContent preserves pointer, metadata, metaprotocol, delegate, rune, properties, propertyEncoding', () => {
    const { orchestrator } = buildOrchestrator();
    const metadata = new Uint8Array([0xa1, 0x61, 0x61, 0x01]); // CBOR {a:1}
    const properties = new Uint8Array([0xa0]); // CBOR {}
    const full = content({
      body: new Uint8Array(0),
      pointer: 100,
      metadata,
      metaprotocol: 'brc-20',
      delegate: '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0',
      rune: 258n,
      properties,
      propertyEncoding: 'br',
    });

    orchestrator.setContent(full);
    const stored = orchestrator.content();

    expect(stored?.pointer).toBe(100);
    expect(stored?.metadata).toBe(metadata);
    expect(stored?.metaprotocol).toBe('brc-20');
    expect(stored?.delegate).toBe('6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0');
    expect(stored?.rune).toBe(258n);
    expect(stored?.properties).toBe(properties);
    expect(stored?.propertyEncoding).toBe('br');
  });
});


describe('InscribeMintOrchestrator — setFeeRate rejects invalid input', () => {

  it('ignores zero, negative, NaN', () => {
    const { orchestrator } = buildOrchestrator();
    orchestrator.setFeeRate(0);
    orchestrator.setFeeRate(-1);
    orchestrator.setFeeRate(NaN);
    expect(orchestrator.feeRate()).toBeNull();

    orchestrator.setFeeRate(5);
    expect(orchestrator.feeRate()).toBe(5);
  });
});


describe('InscribeMintOrchestrator — reset()', () => {

  it('wipes form state and transitions to ready when wallet is connected', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();

    orchestrator.setFeeRate(5);
    orchestrator.setContent(content());
    orchestrator['successResult'].set({ commitTxId: 'x' } as InscribeAndBroadcastResult);
    orchestrator['state'].set('success');

    orchestrator.reset();

    expect(orchestrator.feeRate()).toBeNull();
    expect(orchestrator.content()).toBeNull();
    expect(orchestrator.successResult()).toBeNull();
    expect(orchestrator.state()).toBe('ready');
    utxoSub.unsubscribe();
  });

  it('wipes form state and stays idle when no wallet is connected', () => {
    const { orchestrator } = buildOrchestrator();
    orchestrator.setFeeRate(5);
    orchestrator.reset();
    expect(orchestrator.state()).toBe('idle');
  });
});
