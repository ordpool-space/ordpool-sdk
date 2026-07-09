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

import { Cat21Service } from '../cat21-mint/cat21.service';
import {
  RecommendedFees,
  TxnOutput,
} from '../cat21-mint/cat21.service.types';
import { bitcoinNetwork } from '../network-token';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';

import { InscribeAndBroadcastResult, inscribeAndBroadcast } from './inscribe-orchestrator';
import { OrdEnvelopeField } from './inscription-envelope';
import { SimulateInscribeFeesResult, simulateInscribeFees } from './inscription-fee.helper';
import { prepareInscribeFundingInput } from './inscription-input-adapter';

/**
 * The per-mint payload the consumer wires into the orchestrator via
 * `setContent`. `body` and `contentType` land in the inscription
 * envelope; `tip` becomes the reveal's vout[1] output; the rest are
 * optional ord envelope tags. Recipient is optional — when unset the
 * inscription lands on the connected wallet's ordinals address.
 */
export interface InscribeContent {
  body: Uint8Array;
  contentType?: string;
  envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
  /** Optional reveal vout[1] tip. Cubes-frontend pins its donation address here. */
  tip?: { address: string; value: number };
  note?: string;
  parent?: string;
  contentEncoding?: 'br';
  /** Override for the inscription's recipient. Defaults to wallet.ordinalsAddress. */
  recipient?: string;
}

/**
 * One row in the orchestrator's `simulations$` stream. Same shape
 * as the cat21 sibling but with the inscribe-specific fee result:
 * - `insufficient: true` — UTXO can't cover
 *   `commitOutputValueSats + commitFeeSats` at the current rate.
 * - `insufficient: false` — UTXO is viable; `simulation` carries the
 *   commit + reveal vsize / fee breakdown for the "this is what'll
 *   happen" panel.
 */
export interface InscribeUtxoSimulation {
  utxo: TxnOutput;
  simulation: SimulateInscribeFeesResult | null;
  insufficient: boolean;
}

/**
 * State machine the consumer's template branches on. Same six-state
 * shape as the cat21 mint orchestrator.
 */
export type InscribeMintState = 'idle' | 'loading-utxos' | 'ready' | 'minting' | 'success' | 'error';

/**
 * High-level inscribe flow. Wraps `Cat21Service` (UTXOs, broadcast) +
 * `WalletService` (connected wallet) + the pure `simulateInscribeFees`
 * / `inscribeAndBroadcast` helpers into one cohesive surface, so
 * consumers drive the same state machine + reactive pipelines with
 * thin templates. Sibling of `Cat21MintOrchestrator`.
 *
 * Singleton (`providedIn: 'root'`) — state persists across route
 * navigations within a session. Auto-resets `feeRate`, `selectedUtxo`,
 * `content`, and the success/error fields when the connected wallet
 * changes (old UTXO is gone; the user picks fresh for the new wallet).
 *
 * # Two-tx model
 *
 * Every inscribe produces a commit + reveal pair. Simulations show
 * the sum of both fees + the funding requirement. `mint()` calls
 * `inscribeAndBroadcast` which signs commit via the wallet, broadcasts
 * both txs sequentially via `Cat21Service.postTransaction`, and returns
 * the pair of txids + the ephemeral bearer key.
 *
 * # Bearer key
 *
 * The ephemeral private key that controls the commit output is
 * returned in `successResult().ephemeral`. Between commit broadcast
 * and reveal broadcast (a few seconds) losing this key means the
 * commit output is unrecoverable. The orchestrator does not persist
 * it — that is a consumer concern.
 */
@Injectable({ providedIn: 'root' })
export class InscribeMintOrchestrator {
  private wallet = inject(WalletService);
  private cat21 = inject(Cat21Service);
  private network = inject(bitcoinNetwork);

  // --- Writable inputs ----------------------------------------------------

  /** sat/vB the user picked (from the fee picker or manually). null until set. */
  readonly feeRate = signal<number | null>(null);

  /** Which UTXO from the list the user picked (consumers wire auto-select). */
  readonly selectedUtxo = signal<TxnOutput | null>(null);

  /** The inscription payload. Simulations only fire when this is set. */
  readonly content = signal<InscribeContent | null>(null);

  // --- Internals ----------------------------------------------------------
  private lastWalletAddress: string | null = null;
  private readonly feeRateSubject = new BehaviorSubject<number | null>(null);
  private readonly contentSubject = new BehaviorSubject<InscribeContent | null>(null);

  // --- Output state -------------------------------------------------------

  readonly state = signal<InscribeMintState>('idle');
  readonly errorMessage = signal<string | null>(null);
  readonly successResult = signal<InscribeAndBroadcastResult | null>(null);

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
   * For each UTXO + current fee rate + set content, run
   * `simulateInscribeFees` to produce the commit + reveal fee
   * breakdown. UTXOs that can't cover `fundingRequirementSats` come
   * through with `insufficient: true` rather than poisoning the whole
   * stream.
   *
   * Re-emits whenever utxos$, wallet, feeRate, or content changes.
   * Emits `[]` when content is null (consumer hasn't wired the
   * inscription payload yet).
   */
  readonly simulations$: Observable<InscribeUtxoSimulation[]> = combineLatest([
    this.utxos$,
    this.wallet.connectedWallet$.pipe(startWith(null as WalletInfo | null)),
    // BehaviorSubject mirrors of the writable signals, fed by
    // `setFeeRate` / `setContent`. Signals stay as canonical writables
    // for template reads; these subjects bridge to the RxJS pipeline
    // without needing the Angular signal-effect runtime (which
    // toObservable depends on and isn't available in plain Injector
    // contexts the SDK tests use).
    this.feeRateSubject,
    this.contentSubject,
  ]).pipe(
    map(([utxos, wallet, feeRate, content]) => this.computeSimulations(utxos, wallet, feeRate, content)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** Pass-through of the SDK's polled fee tiers. */
  readonly recommendedFees$: Observable<RecommendedFees> = this.cat21.recommendedFees$;

  // --- Setup --------------------------------------------------------------

  constructor() {
    // Auto-reset writables when the wallet changes — the old UTXO is
    // no longer in the new wallet's list, and stale fee / content
    // state must not leak across sessions. Subscription leak is fine:
    // the service is providedIn:'root' so its lifetime is the app's.
    this.walletChangeSub = this.wallet.connectedWallet$.subscribe((w) => {
      if (!w) {
        this.lastWalletAddress = null;
        this.resetFormState();
        return;
      }
      if (this.lastWalletAddress === w.ordinalsAddress) return;
      this.lastWalletAddress = w.ordinalsAddress;
      this.resetFormState();
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

  setContent(content: InscribeContent | null): void {
    this.content.set(content);
    this.contentSubject.next(content);
  }

  /**
   * Trigger the inscribe. Requires a connected wallet, a feeRate set,
   * a selectedUtxo, and content set. Composes:
   *   1. `simulateInscribeFees` for the picked UTXO to derive the
   *      exact commit / reveal fee at broadcast time.
   *   2. `inscribeAndBroadcast` — signs the commit input via the
   *      wallet, broadcasts commit, signs reveal internally,
   *      broadcasts reveal — via `Cat21Service.postTransaction`.
   *
   * Transitions state to `minting` → `success` (with `successResult`)
   * or `error` (with `errorMessage`).
   */
  mint(): Observable<InscribeAndBroadcastResult> {
    const wallet = this.connectedWallet();
    const feeRate = this.feeRate();
    const selected = this.selectedUtxo();
    const content = this.content();

    if (!wallet) return throwError(() => new Error('No wallet connected'));
    if (!feeRate) return throwError(() => new Error('No fee rate set'));
    if (!selected) return throwError(() => new Error('No UTXO selected'));
    if (!content) return throwError(() => new Error('No inscription content set'));

    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    const recipient = content.recipient ?? wallet.ordinalsAddress;

    this.state.set('minting');
    this.errorMessage.set(null);
    this.successResult.set(null);

    return inscribeAndBroadcast({
      walletType: wallet.type,
      paymentOutput: selected,
      paymentPublicKey,
      paymentAddress: wallet.paymentAddress,
      recipientAddress: recipient,
      body: content.body,
      contentType: content.contentType,
      envelopeFields: content.envelopeFields,
      feeRatePerVbyte: feeRate,
      tip: content.tip,
      note: content.note,
      parent: content.parent,
      contentEncoding: content.contentEncoding,
      network: this.network,
      broadcast: (txHex: string) => this.cat21.postTransaction(txHex),
    }).pipe(
      tap((result) => {
        this.successResult.set(result);
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
    this.resetFormState();
    this.state.set(this.connectedWallet() ? 'ready' : 'idle');
  }

  // --- Internals ----------------------------------------------------------

  private resetFormState(): void {
    this.feeRate.set(null);
    this.feeRateSubject.next(null);
    this.selectedUtxo.set(null);
    this.content.set(null);
    this.contentSubject.next(null);
    this.errorMessage.set(null);
    this.successResult.set(null);
  }

  private computeSimulations(
    utxos: TxnOutput[],
    wallet: WalletInfo | null,
    feeRate: number | null,
    content: InscribeContent | null,
  ): InscribeUtxoSimulation[] {
    if (!wallet || !feeRate || !content || utxos.length === 0) return [];

    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    const recipient = content.recipient ?? wallet.ordinalsAddress;
    // Deterministic dummy x-only pubkey; simulateInscribeFees only
    // uses it to size the envelope (all 32-byte pubkeys produce the
    // same envelope byte count). The real ephemeral key is generated
    // inside `inscribeAndBroadcast` at mint time.
    const dummyPubkeyXonly = new Uint8Array(32).fill(0x02);

    const out: InscribeUtxoSimulation[] = [];
    for (const utxo of utxos) {
      try {
        const fundingInput = prepareInscribeFundingInput({
          utxo,
          paymentPublicKey,
          paymentAddress: wallet.paymentAddress,
          isSimulation: true,
          network: this.network,
        });
        const simulation = simulateInscribeFees({
          feeRatePerVbyte: feeRate,
          body: content.body,
          contentType: content.contentType,
          envelopeFields: content.envelopeFields,
          fundingInput,
          senderChangeAddress: wallet.paymentAddress,
          recipientAddress: recipient,
          ephemeralPubkeyXonly: dummyPubkeyXonly,
          tip: content.tip,
          walletType: wallet.type,
          network: this.network,
        });
        // Second gate: the UTXO must fund the whole commit
        // (commitOutputValueSats + commitFeeSats). `simulateInscribeFees`
        // itself doesn't reject on insufficient — it just reports the
        // requirement. The commit builder would throw at real mint
        // time on inputs < requirement; flag here so the picker
        // greys out unusable rows.
        if (utxo.value < simulation.fundingRequirementSats) {
          out.push({ utxo, simulation, insufficient: true });
        } else {
          out.push({ utxo, simulation, insufficient: false });
        }
      } catch (err) {
        // Layer-1 / Layer-2 refused this UTXO (e.g., legacy P2PKH
        // without transactionHex, or address adapter rejection).
        // Surface as insufficient so the picker greys it out.
        console.error('[inscribe-mint-orchestrator] simulation threw for utxo', utxo.txid, ':', err);
        out.push({ utxo, simulation: null, insufficient: true });
      }
    }
    return out;
  }
}
