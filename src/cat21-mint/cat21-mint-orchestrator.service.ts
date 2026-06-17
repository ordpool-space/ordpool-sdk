import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { hex } from '@scure/base';
import {
  BehaviorSubject,
  Observable,
  Subscription,
  catchError,
  combineLatest,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  tap,
  throwError,
} from 'rxjs';

import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';
import { Cat21Service } from './cat21.service';
import {
  RecommendedFees,
  SimulateTransactionResult,
  TxnOutput,
} from './cat21.service.types';

/**
 * One row in the orchestrator's `simulations$` stream. Either:
 * - `insufficient: true` — the UTXO can't cover the recipient amount
 *   (546 sats) + the fee at the current rate. `simulation` is null.
 * - `insufficient: false` — UTXO is viable; `simulation` carries the
 *   full breakdown (vsize, miner fee, change amount, etc.) the UI
 *   needs to render an "this is what'll happen" panel.
 */
export interface UtxoSimulation {
  utxo: TxnOutput;
  simulation: SimulateTransactionResult | null;
  insufficient: boolean;
}

/**
 * State machine the consumer's template branches on. Single-source-of-
 * truth for "what should the UI show right now":
 *
 *  - `idle` — no wallet connected.
 *  - `loading-utxos` — wallet just connected, fetching UTXOs from electrs.
 *  - `ready` — UTXOs loaded; the form is interactive.
 *  - `minting` — user clicked "Mint", PSBT being signed / broadcast.
 *  - `success` — broadcast OK; `successTxId` holds the txid.
 *  - `error` — something failed; `errorMessage` holds the reason.
 */
export type MintState = 'idle' | 'loading-utxos' | 'ready' | 'minting' | 'success' | 'error';

/**
 * High-level mint flow. Wraps `Cat21Service` (UTXOs, simulation,
 * broadcast) + `WalletService` (the currently connected wallet) into
 * one cohesive surface so both consumers (ordpool/frontend and
 * cat21-indexer/frontend) drive the same state machine and reactive
 * pipelines with thin templates.
 *
 * Singleton (`providedIn: 'root'`) — state persists across route
 * navigations within a session. Auto-resets `feeRate` + `selectedUtxo`
 * + the success/error fields when the connected wallet changes (the
 * old UTXO is gone; the user picks fresh for the new wallet).
 */
@Injectable({ providedIn: 'root' })
export class Cat21MintOrchestrator {
  private wallet = inject(WalletService);
  private cat21 = inject(Cat21Service);

  // --- Writable inputs ----------------------------------------------------

  /** sat/vB the user picked (from the fee picker or manually). null until set. */
  readonly feeRate = signal<number | null>(null);

  /** Which UTXO from the list the user picked (auto-set to the largest viable one by default). */
  readonly selectedUtxo = signal<TxnOutput | null>(null);

  // --- Internals (declared up here because instance-field initialisers
  // below depend on them at class-construction time).
  private lastWalletAddress: string | null = null;
  private readonly feeRateSubject = new BehaviorSubject<number | null>(null);

  // --- Output state -------------------------------------------------------

  readonly state = signal<MintState>('idle');
  readonly errorMessage = signal<string | null>(null);
  readonly successTxId = signal<string | null>(null);

  /** Currently connected wallet bridged to a signal for template reads. */
  readonly connectedWallet = toSignal(this.wallet.connectedWallet$, { initialValue: null });

  /** Convenience computed for `state() === 'ready'` gating. */
  readonly isReady = computed(() => this.state() === 'ready');

  // --- Derived streams ----------------------------------------------------

  /**
   * UTXOs for the connected wallet's payment address. Re-fetches on
   * wallet change. Errors are mapped to an empty list and an error
   * state. Shared between subscribers via `shareReplay` so the side
   * effects on `state` only fire once per emission.
   *
   * `startWith(null)` keeps the chain hot before any wallet connects;
   * downstream `simulations$` then emits `[]` instead of stalling.
   */
  readonly utxos$: Observable<TxnOutput[]> = this.wallet.connectedWallet$.pipe(
    startWith(null as WalletInfo | null),
    switchMap((w) => {
      if (!w) {
        this.state.set('idle');
        return of([] as TxnOutput[]);
      }
      this.state.set('loading-utxos');
      return this.cat21.getUtxos(w.paymentAddress).pipe(
        tap(() => this.state.set('ready')),
        catchError((err: unknown) => {
          this.errorMessage.set(`Failed to load UTXOs: ${err instanceof Error ? err.message : String(err)}`);
          this.state.set('error');
          return of([] as TxnOutput[]);
        }),
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * For each UTXO + current fee rate, run the two-pass simulation
   * (pass 1 estimates vsize at fee=0; pass 2 uses the real fee
   * derived from vsize × feeRate). UTXOs that throw on simulation
   * (insufficient funds at this fee rate) come through with
   * `insufficient: true` rather than poisoning the whole stream.
   *
   * Re-emits whenever utxos$ or feeRate changes.
   */
  readonly simulations$: Observable<UtxoSimulation[]> = combineLatest([
    this.utxos$,
    this.wallet.connectedWallet$.pipe(startWith(null as WalletInfo | null)),
    // BehaviorSubject mirror of the writable feeRate signal, fed by
    // `setFeeRate`. The signal stays as the canonical writable for
    // template reads; this subject just bridges to the RxJS pipeline
    // without needing the Angular signal-effect runtime (which
    // toObservable depends on and isn't available in plain Injector
    // contexts the SDK tests use).
    this.feeRateSubject,
  ]).pipe(
    map(([utxos, wallet, feeRate]) => this.computeSimulations(utxos, wallet, feeRate)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** Pass-through of the SDK's polled fee tiers. */
  readonly recommendedFees$: Observable<RecommendedFees> = this.cat21.recommendedFees$;

  // --- Setup --------------------------------------------------------------

  constructor() {
    // Auto-reset writables when the wallet changes — the old UTXO is
    // no longer in the new wallet's list, and we don't want stale fee
    // state leaking across sessions. Subscription leak is fine: the
    // service is providedIn:'root' so its lifetime is the app's.
    this.walletChangeSub = this.wallet.connectedWallet$.subscribe((w) => {
      if (!w) {
        this.lastWalletAddress = null;
        this.feeRate.set(null);
        this.feeRateSubject.next(null);
        this.selectedUtxo.set(null);
        this.errorMessage.set(null);
        this.successTxId.set(null);
        return;
      }
      // Same wallet re-emitted (BehaviorSubject replay etc.) — leave
      // form state intact so the user doesn't lose what they typed.
      if (this.lastWalletAddress === w.ordinalsAddress) return;
      this.lastWalletAddress = w.ordinalsAddress;
      this.feeRate.set(null);
      this.feeRateSubject.next(null);
      this.selectedUtxo.set(null);
      this.errorMessage.set(null);
      this.successTxId.set(null);
    });
  }
  private readonly walletChangeSub: Subscription;

  // --- Commands -----------------------------------------------------------

  setFeeRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.feeRate.set(rate);
    this.feeRateSubject.next(rate);
  }

  setSelectedUtxo(utxo: TxnOutput | null): void {
    this.selectedUtxo.set(utxo);
  }

  /**
   * Trigger the mint. Requires a connected wallet, a feeRate set, and
   * a selectedUtxo. Computes the precise fee from the simulation,
   * dispatches `Cat21Service.createCat21Transaction`, transitions
   * state to `minting` → `success` (with `successTxId`) or `error`
   * (with `errorMessage`).
   */
  mint(): Observable<{ txId: string }> {
    const wallet = this.connectedWallet();
    const feeRate = this.feeRate();
    const selected = this.selectedUtxo();

    if (!wallet) return throwError(() => new Error('No wallet connected'));
    if (!feeRate) return throwError(() => new Error('No fee rate set'));
    if (!selected) return throwError(() => new Error('No UTXO selected'));

    let transactionFee: bigint;
    try {
      // Layer-3 two-pass fee simulation. Pass-1 with placeholder fee
      // measures vsize; pass-2 with the provisional fee measures the
      // FINAL vsize (which may differ if the change crossed dust
      // between passes). The miner gets exactly `vsize × feeRate`,
      // never a stale over-pay from a single-pass estimate.
      const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
      const { finalFeeSats } = twoPassFeeSimulation({
        simulate: (feeSats) => this.cat21.simulateTransaction(
          wallet.type,
          wallet.ordinalsAddress,
          selected,
          wallet.paymentAddress,
          paymentPublicKey,
          BigInt(feeSats),
        ),
        feeRatePerVbyte: feeRate,
      });
      transactionFee = BigInt(finalFeeSats);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(msg);
      this.state.set('error');
      return throwError(() => err);
    }

    this.state.set('minting');
    this.errorMessage.set(null);
    this.successTxId.set(null);

    return this.cat21
      .createCat21Transaction(
        wallet.type,
        wallet.ordinalsAddress,
        selected,
        wallet.paymentAddress,
        hex.decode(wallet.paymentPublicKey),
        transactionFee,
      )
      .pipe(
        tap(({ txId }) => {
          this.successTxId.set(txId);
          this.state.set('success');
        }),
        catchError((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errorMessage.set(msg);
          this.state.set('error');
          return throwError(() => err);
        }),
      );
  }

  /**
   * Wipe form state back to a fresh mint (typically the "Mint another"
   * button on the success screen). Keeps the wallet connected.
   */
  reset(): void {
    this.feeRate.set(null);
    this.feeRateSubject.next(null);
    this.selectedUtxo.set(null);
    this.errorMessage.set(null);
    this.successTxId.set(null);
    this.state.set(this.connectedWallet() ? 'ready' : 'idle');
  }

  // --- Internals ----------------------------------------------------------

  private computeSimulations(
    utxos: TxnOutput[],
    wallet: WalletInfo | null,
    feeRate: number | null,
  ): UtxoSimulation[] {
    if (!wallet || !feeRate || utxos.length === 0) return [];

    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    const out: UtxoSimulation[] = [];
    for (const utxo of utxos) {
      try {
        // Layer-3 two-pass: pass-1 measures vsize with placeholder fee,
        // pass-2 re-measures after change-vs-dust resolves. `finalSimulation`
        // is the pass-2 result — exactly the simulation we'd display.
        const { finalSimulation: simulation } = twoPassFeeSimulation({
          simulate: (feeSats) => this.cat21.simulateTransaction(
            wallet.type,
            wallet.ordinalsAddress,
            utxo,
            wallet.paymentAddress,
            paymentPublicKey,
            BigInt(feeSats),
          ),
          feeRatePerVbyte: feeRate,
        });
        out.push({ utxo, simulation, insufficient: false });
      } catch {
        // simulateTransaction throws on "Insufficient funds for
        // transaction" — expected for UTXOs too small to cover the
        // 546-sat output + the current fee. Surface as a flagged
        // entry so the picker can grey it out instead of hiding it.
        out.push({ utxo, simulation: null, insufficient: true });
      }
    }
    return out;
  }
}
