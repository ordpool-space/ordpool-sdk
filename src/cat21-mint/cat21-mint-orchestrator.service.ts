import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { hex } from '@scure/base';
import {
  BehaviorSubject,
  Observable,
  Subscription,
  catchError,
  combineLatest,
  distinctUntilChanged,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  tap,
  throwError,
} from 'rxjs';

import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { FundingRecommendationService } from '../cat21-fee/funding-recommendation.service';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
} from '../cat21-fee/funding-safety';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
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
  private fundingRec = inject(FundingRecommendationService);

  // --- Writable inputs ----------------------------------------------------

  /** sat/vB the user picked (from the fee picker or manually). null until set. */
  readonly feeRate = signal<number | null>(null);

  /**
   * Which UTXO the user explicitly picked (expert mode). When null, `mint()`
   * falls back to the SAFE auto-recommendation (`fundingRecommendation$`): a
   * content-clean covering UTXO when one exists (`status: 'auto'`, the invisible
   * comfortable default), otherwise no auto-mint (`status: 'expert-required'` —
   * the UI must surface the picker so the user consciously mints on an
   * asset-carrying coin). Setting this is the expert-mode override, honoured
   * even for an asset coin the user chose deliberately.
   */
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
    // Guard against `connectedWallet$` re-emitting the same wallet.
    // WalletService fires `.next(info)` on service construction (rehydrate
    // from localStorage) AND on every connector `onAccountChange` event —
    // and connectors like Xverse fire that event repeatedly after a
    // reload. Without this guard, `switchMap` re-cancels the in-flight
    // getUtxos + resets `state` to 'loading-utxos' faster than downstream
    // consumers (paymentOutputs$/auto-pick) can settle, and the mint
    // form's "found funds" banner never surfaces. Key by paymentAddress
    // — the sole input to `getUtxos` — so a genuine wallet switch still
    // re-fetches.
    distinctUntilChanged((a, b) => (a?.paymentAddress ?? null) === (b?.paymentAddress ?? null)),
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
    // Same distinctUntilChanged guard as utxos$: connectedWallet$ can
    // re-emit the same wallet repeatedly, which would otherwise re-fire
    // simulations$ downstream.
    this.wallet.connectedWallet$.pipe(
      startWith(null as WalletInfo | null),
      distinctUntilChanged((a, b) => (a?.paymentAddress ?? null) === (b?.paymentAddress ?? null)),
    ),
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

  /**
   * The funding target the coin-selection safety check must cover: the fresh
   * cat's postage (546) + the miner fee (a generous ~200 vB ceiling; the
   * two-pass simulation tightens the real fee). A mint UTXO must clear this to
   * be viable. Null until a fee rate is set.
   */
  private readonly fundingTarget$: Observable<number | null> = this.feeRateSubject.pipe(
    map((rate) => (rate && rate > 0 ? CAT21_POSTAGE_SATS + Math.ceil(rate * 200) : null)),
  );

  /**
   * SAFE-by-default coin-selection recommendation for the mint's funding
   * (shared brain, identical across mint / transfer / offer / inscribe). Emits
   * `auto` (a content-clean coin covers → auto-selected, no picker),
   * `expert-required` (only asset-bearing coins cover → the UI surfaces the
   * picker), `scanning`, or `insufficient`. Degrades to `insufficient` if the
   * UTXO fetch errors, so a load failure never yields an unsafe auto-mint. The
   * UI branches on `.status`; the invisible default is `auto`.
   */
  readonly fundingRecommendation$: Observable<
    FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>
  > = this.fundingRec.recommend<TxnOutput>(this.utxos$, this.fundingTarget$).pipe(
    catchError(() =>
      of<FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>>({
        status: 'insufficient',
        recommended: null,
        candidates: [],
      }),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  private lastRecommendationSnapshot: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
    status: 'insufficient',
    recommended: null,
    candidates: [],
  };

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
    // Maintain a synchronous snapshot of the safe funding recommendation for
    // mint()'s auto-fallback. Subscribed AFTER walletChangeSub on purpose: on a
    // wallet switch the reset (which clears errorMessage) must run before the
    // utxos$ error path (which sets it), which the connectedWallet$ subscription
    // order guarantees only when this attaches second.
    this.recommendationSnapshotSub = this.fundingRecommendation$.subscribe((r) => {
      this.lastRecommendationSnapshot = r;
    });
  }
  private readonly walletChangeSub: Subscription;
  private readonly recommendationSnapshotSub: Subscription;

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
  mint(
    // Watch-only (xpub) wallets sign via this export/paste bridge; injected
    // wallets ignore it. A watch-only mint throws without it (psbtExportSigner).
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Observable<string>,
  ): Observable<{ txId: string }> {
    const wallet = this.connectedWallet();
    const feeRate = this.feeRate();
    // Expert-mode pick wins; otherwise fall back to the SAFE auto-recommendation
    // — but ONLY a content-clean covering coin (`status: 'auto'`). When only
    // asset coins cover (`expert-required`) there is no safe auto-mint: error so
    // the UI surfaces the picker instead of silently minting on a valuable coin.
    const recommendation = this.lastRecommendationSnapshot;
    const selected =
      this.selectedUtxo() ??
      (recommendation.status === 'auto' ? recommendation.recommended : null);

    if (!wallet) return throwError(() => new Error('No wallet connected'));
    if (!feeRate) return throwError(() => new Error('No fee rate set'));
    if (!selected) {
      const msg =
        recommendation.status === 'expert-required'
          ? 'Select a funding UTXO (the available coins carry assets)'
          : 'No UTXO selected';
      return throwError(() => new Error(msg));
    }

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
        promptForSignedPsbt,
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
        // Layer-3 two-pass: pass-1 measures vsize with a placeholder fee,
        // pass-2 re-measures after change-vs-dust resolves. `finalSimulation`
        // is the pass-2 result; `finalFeeSats` is the authoritative fee
        // (rate × pass-2 vsize) — exactly what mint() charges
        // (createCat21Transaction is called with it).
        const { finalSimulation, finalFeeSats } = twoPassFeeSimulation({
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
        // Normalize the DISPLAYED fee to the charged fee. finalSimulation is
        // built with the provisional (pass-1-vsize) fee, which equals
        // finalFeeSats in the common case but diverges when the change output
        // crosses the dust threshold between passes; the grid must never quote
        // a fee different from what mint() charges. (In the divergent case the
        // change is absorbed to 0 in both, so only the fee field needs it.)
        const simulation = { ...finalSimulation, finalTransactionFee: BigInt(finalFeeSats) };
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
