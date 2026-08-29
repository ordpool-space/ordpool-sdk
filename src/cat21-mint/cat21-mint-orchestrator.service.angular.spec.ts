import { describe, expect, it, jest } from '@jest/globals';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Observable, Subject, combineLatest, firstValueFrom, map, of, throwError } from 'rxjs';

import { FundingRecommendationService } from '../cat21-fee/funding-recommendation.service';
import { recommendFunding } from '../cat21-fee/funding-safety';
import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';
import { makeXverseWallet as wallet } from '../testing/fixtures';
import { Cat21MintOrchestrator } from './cat21-mint-orchestrator.service';
import { Cat21Service } from './cat21.service';
import { cat21Config } from './cat21-sdk-config';
import { SimulateTransactionResult, TxnOutput } from './cat21.service.types';

const utxo = (overrides: Partial<TxnOutput> = {}): TxnOutput => ({
  txid: 'a'.repeat(64),
  vout: 0,
  value: 50_000,
  status: { confirmed: true },
  ...overrides,
});

const simulation = (overrides: Partial<SimulateTransactionResult> = {}): SimulateTransactionResult => ({
  tx: {} as SimulateTransactionResult['tx'],
  amountToRecipient: 546n,
  singleInputAmount: 50_000n,
  changeAmount: 47_704n,
  finalTransactionFee: 1_750n,
  vsize: 175,
  ...overrides,
});

type MockWalletService = {
  connectedWallet$: BehaviorSubject<WalletInfo | null>;
};

type MockCat21Service = {
  getUtxos: jest.MockedFunction<Cat21Service['getUtxos']>;
  simulateTransaction: jest.MockedFunction<Cat21Service['simulateTransaction']>;
  createCat21Transaction: jest.MockedFunction<Cat21Service['createCat21Transaction']>;
  recommendedFees$: typeof Cat21Service.prototype.recommendedFees$;
};

const buildOrchestrator = (opts: {
  // Outpoints (`txid:vout`) to mark as asset-bearing so the recommendation
  // returns `expert-required` instead of `auto`. Everything else is clean.
  assetOutpoints?: Set<string>;
} = {}): {
  orchestrator: Cat21MintOrchestrator;
  walletSubject: BehaviorSubject<WalletInfo | null>;
  cat21: MockCat21Service;
} => {
  const walletSubject = new BehaviorSubject<WalletInfo | null>(null);
  const cat21: MockCat21Service = {
    getUtxos: jest.fn(),
    simulateTransaction: jest.fn(),
    createCat21Transaction: jest.fn(),
    recommendedFees$: new Subject<never>() as unknown as Cat21Service['recommendedFees$'],
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
        map(([utxos, target]) =>
          recommendFunding(
            utxos.map((u) => ({
              ...u,
              bucket: assetOutpoints.has(`${u.txid}:${u.vout}`) ? ('assets' as const) : ('clean' as const),
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

  const orchestrator = runInInjectionContext(injector, () => new Cat21MintOrchestrator());
  return { orchestrator, walletSubject, cat21 };
};


describe('Cat21MintOrchestrator — state machine', () => {


  it('starts idle with no wallet connected', () => {
    const { orchestrator } = buildOrchestrator();
    expect(orchestrator.state()).toBe('idle');
    expect(orchestrator.connectedWallet()).toBeNull();
  });

  it('transitions loading-utxos -> ready when a wallet connects and UTXOs load', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));

    // Trigger the utxos$ chain by subscribing to it (templates do this
    // via async pipe / toSignal). Without a subscriber the shareReplay
    // refcount stays at 0 and the chain doesn't run.
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


describe('Cat21MintOrchestrator — auto-reset on wallet change', () => {


  it('clears feeRate + selectedUtxo + error/success fields when a different wallet connects', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();

    walletSubject.next(wallet({ ordinalsAddress: 'bc1pold-ordinals', paymentAddress: 'bc1qold-pay' }));
    await Promise.resolve();

    orchestrator.setFeeRate(7);
    orchestrator.setSelectedUtxo(utxo({ txid: 'b'.repeat(64) }));
    orchestrator['errorMessage'].set('something broke');
    orchestrator['successTxId'].set('past-txid');

    expect(orchestrator.feeRate()).toBe(7);
    expect(orchestrator.selectedUtxo()?.txid).toBe('b'.repeat(64));

    walletSubject.next(wallet({ ordinalsAddress: 'bc1pnew-ordinals', paymentAddress: 'bc1qnew-pay' }));
    await Promise.resolve();

    expect(orchestrator.feeRate()).toBeNull();
    expect(orchestrator.selectedUtxo()).toBeNull();
    expect(orchestrator.errorMessage()).toBeNull();
    expect(orchestrator.successTxId()).toBeNull();
    utxoSub.unsubscribe();
  });
});


describe('Cat21MintOrchestrator — simulations$', () => {


  it('emits empty array when fee rate is unset', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    walletSubject.next(wallet());

    const value = await firstValueFrom(orchestrator.simulations$);
    expect(value).toEqual([]);
  });

  it('runs the two-pass simulation per UTXO and emits viable rows', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo({ txid: 'u1' + '0'.repeat(62) })]));
    cat21.simulateTransaction.mockReturnValue(simulation());

    walletSubject.next(wallet());
    orchestrator.setFeeRate(10);

    const value = await firstValueFrom(orchestrator.simulations$);
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({
      utxo: { txid: 'u1' + '0'.repeat(62) },
      insufficient: false,
    });
    expect(value[0].simulation?.vsize).toBe(175);
    // Two-pass: pass 1 at fee=0, pass 2 at fee=ceil(vsize × rate).
    expect(cat21.simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('flags a UTXO as insufficient when simulateTransaction throws', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([
      utxo({ txid: 'u1' + '0'.repeat(62), value: 50_000 }),
      utxo({ txid: 'u2' + '0'.repeat(62), value: 100 }),
    ]));
    cat21.simulateTransaction
      .mockReturnValueOnce(simulation()) // u1 vsize pass
      .mockReturnValueOnce(simulation()) // u1 fee pass
      .mockImplementationOnce(() => { throw new Error('Insufficient funds for transaction'); });

    walletSubject.next(wallet());
    orchestrator.setFeeRate(10);

    const value = await firstValueFrom(orchestrator.simulations$);
    expect(value).toHaveLength(2);
    expect(value[0].insufficient).toBe(false);
    expect(value[1].insufficient).toBe(true);
    expect(value[1].simulation).toBeNull();
  });
});


describe('Cat21MintOrchestrator.mint()', () => {


  it('refuses with a clear error when no wallet is connected', async () => {
    const { orchestrator } = buildOrchestrator();
    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow('No wallet connected');
  });

  it('refuses with a clear error when feeRate is unset', async () => {
    const { orchestrator, walletSubject } = buildOrchestrator();
    walletSubject.next(wallet());
    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow('No fee rate set');
  });

  it('refuses with a clear error when no UTXO is selected', async () => {
    const { orchestrator, walletSubject } = buildOrchestrator();
    walletSubject.next(wallet());
    orchestrator.setFeeRate(10);
    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow('No UTXO selected');
  });

  it('transitions minting -> success and stores the txId on broadcast', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.simulateTransaction.mockReturnValue(simulation());
    cat21.createCat21Transaction.mockReturnValue(of({ txId: 'broadcast-txid' }));

    walletSubject.next(wallet());
    orchestrator.setFeeRate(5);
    orchestrator.setSelectedUtxo(utxo());

    const result = await firstValueFrom(orchestrator.mint());

    expect(result).toEqual({ txId: 'broadcast-txid' });
    expect(orchestrator.state()).toBe('success');
    expect(orchestrator.successTxId()).toBe('broadcast-txid');
    expect(orchestrator.errorMessage()).toBeNull();
  });

  it('transitions minting -> error and stores the message on broadcast failure', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.simulateTransaction.mockReturnValue(simulation());
    cat21.createCat21Transaction.mockReturnValue(throwError(() => new Error('user rejected')));

    walletSubject.next(wallet());
    orchestrator.setFeeRate(5);
    orchestrator.setSelectedUtxo(utxo());

    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow('user rejected');
    expect(orchestrator.state()).toBe('error');
    expect(orchestrator.errorMessage()).toBe('user rejected');
  });

  it('passes the fee derived from vsize × feeRate to createCat21Transaction', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.simulateTransaction.mockReturnValue(simulation({ vsize: 175 }));
    cat21.createCat21Transaction.mockReturnValue(of({ txId: 'tx' }));

    walletSubject.next(wallet());
    orchestrator.setFeeRate(8);
    orchestrator.setSelectedUtxo(utxo());

    await firstValueFrom(orchestrator.mint());

    // 175 × 8 = 1400 sats fee
    const lastCall = cat21.createCat21Transaction.mock.calls[0];
    expect(lastCall[5]).toBe(1400n);
  });
});

describe('Cat21MintOrchestrator — safe-auto coin selection (the vision)', () => {

  it('AUTO (invisible default): mint() auto-picks a clean covering UTXO when none is manually selected', async () => {
    const clean = utxo({ txid: 'c'.repeat(64), value: 50_000 });
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([clean]));
    cat21.simulateTransaction.mockReturnValue(simulation());
    cat21.createCat21Transaction.mockReturnValue(of({ txId: 'auto-txid' }));

    walletSubject.next(wallet());
    orchestrator.setFeeRate(5);
    // NO setSelectedUtxo — the safe auto-recommendation must fill in.

    const rec = await firstValueFrom(orchestrator.fundingRecommendation$);
    expect(rec.status).toBe('auto');
    expect(rec.recommended?.txid).toBe(clean.txid);

    const result = await firstValueFrom(orchestrator.mint());
    expect(result).toEqual({ txId: 'auto-txid' });
    // createCat21Transaction (arg 2 = the funding UTXO) received the auto-pick.
    expect(cat21.createCat21Transaction.mock.calls[0][2].txid).toBe(clean.txid);
  });

  it('EXPERT-REQUIRED: only an asset coin covers -> mint() refuses and asks for a pick', async () => {
    const assetCoin = utxo({ txid: 'd'.repeat(64), value: 50_000 });
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator({
      assetOutpoints: new Set([`${assetCoin.txid}:${assetCoin.vout}`]),
    });
    cat21.getUtxos.mockReturnValue(of([assetCoin]));

    walletSubject.next(wallet());
    orchestrator.setFeeRate(5);

    const rec = await firstValueFrom(orchestrator.fundingRecommendation$);
    expect(rec.status).toBe('expert-required');

    // No silent auto-mint on a valuable coin — the UI must surface the picker.
    await expect(firstValueFrom(orchestrator.mint())).rejects.toThrow(/Select a funding UTXO/);
  });

  it('EXPERT OVERRIDE: an explicit pick of the asset coin is honoured (the user chose it)', async () => {
    const assetCoin = utxo({ txid: 'd'.repeat(64), value: 50_000 });
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator({
      assetOutpoints: new Set([`${assetCoin.txid}:${assetCoin.vout}`]),
    });
    cat21.getUtxos.mockReturnValue(of([assetCoin]));
    cat21.simulateTransaction.mockReturnValue(simulation());
    cat21.createCat21Transaction.mockReturnValue(of({ txId: 'override-txid' }));

    walletSubject.next(wallet());
    orchestrator.setFeeRate(5);
    orchestrator.setSelectedUtxo(assetCoin);

    const result = await firstValueFrom(orchestrator.mint());
    expect(result).toEqual({ txId: 'override-txid' });
    expect(cat21.createCat21Transaction.mock.calls[0][2].txid).toBe(assetCoin.txid);
  });
});


describe('Cat21MintOrchestrator.reset()', () => {


  it('clears inputs + error/success and returns to ready when a wallet is still connected', async () => {
    const { orchestrator, walletSubject, cat21 } = buildOrchestrator();
    cat21.getUtxos.mockReturnValue(of([utxo()]));
    const utxoSub = orchestrator.utxos$.subscribe();
    walletSubject.next(wallet());
    await Promise.resolve();

    orchestrator.setFeeRate(7);
    orchestrator.setSelectedUtxo(utxo());
    orchestrator['successTxId'].set('past-txid');

    orchestrator.reset();

    expect(orchestrator.feeRate()).toBeNull();
    expect(orchestrator.selectedUtxo()).toBeNull();
    expect(orchestrator.successTxId()).toBeNull();
    expect(orchestrator.errorMessage()).toBeNull();
    expect(orchestrator.state()).toBe('ready');
    utxoSub.unsubscribe();
  });

  it('returns to idle when no wallet is connected', () => {
    const { orchestrator } = buildOrchestrator();
    orchestrator.reset();
    expect(orchestrator.state()).toBe('idle');
  });
});
