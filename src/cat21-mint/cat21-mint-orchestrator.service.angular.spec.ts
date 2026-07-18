import { describe, expect, it, jest } from '@jest/globals';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject, firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { WalletService } from '../wallet/wallet.service';
import { KnownOrdinalWalletType, WalletInfo } from '../wallet/wallet.service.types';
import { makeWallet } from '../testing/fixtures';
import { Cat21MintOrchestrator } from './cat21-mint-orchestrator.service';
import { Cat21Service } from './cat21.service';
import { cat21Config } from './cat21-sdk-config';
import { SimulateTransactionResult, TxnOutput } from './cat21.service.types';

const wallet = (overrides: Partial<WalletInfo> = {}): WalletInfo =>
  makeWallet({ type: KnownOrdinalWalletType.xverse, ...overrides });

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

const buildOrchestrator = (): {
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

  const injector = Injector.create({
    providers: [
      { provide: WalletService, useValue: { connectedWallet$: walletSubject } satisfies MockWalletService },
      { provide: Cat21Service, useValue: cat21 },
      { provide: bitcoinNetwork, useValue: Network.Mainnet },
      { provide: cat21Config, useValue: { mempoolApiUrl: 'https://mempool.test', cat21ApiUrl: 'https://api.cat21.test' } },
      { provide: storage, useValue: { getValue: () => null, setValue: () => {}, removeItem: () => {} } },
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
