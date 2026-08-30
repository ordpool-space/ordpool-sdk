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

import { Cat21Holding } from './cat21-transfer.types';
import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { FundingRecommendationService } from '../cat21-fee/funding-recommendation.service';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
} from '../cat21-fee/funding-safety';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { RecommendedFees, TxnOutput } from '../cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../network';
import { bitcoinNetwork } from '../network-token';
import { findSignerOrThrow } from '../wallet/signers';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';
import { getMinimumUtxoSize } from '../cat21-script/address-format';
import { buildCat21TransferPsbt, CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS } from './cat21-transfer.helper';
import {
  prepareTransferCatInput,
  prepareTransferFundingInput,
} from './cat21-transfer-input-adapter';
import {
  Cat21TransferCatInput,
  Cat21TransferFundingInput,
} from './cat21-transfer.types';

// Cat21Holding moved to cat21-transfer.types (framework-agnostic); re-exported
// here so consumers importing it from the orchestrator keep working.
export type { Cat21Holding };

/**
 * Result of the per-fee-rate simulation. Either:
 * - `insufficient: true` — funding UTXOs can't cover postage + fee
 *   at the chosen rate. `simulation` is null.
 * - `insufficient: false` — viable; the simulation breakdown drives
 *   the "this is what'll happen" panel.
 */
export interface TransferSimulation {
  vsize: number;
  feeSats: number;
  changeSats: number;
  fundingUtxo: TxnOutput;
}

export interface TransferSimulationOutcome {
  simulation: TransferSimulation | null;
  insufficient: boolean;
}

/**
 * State machine the consumer's template branches on:
 *  - `idle` — no wallet connected.
 *  - `loading-utxos` — wallet just connected, fetching UTXOs from electrs.
 *  - `ready` — UTXOs loaded; form is interactive.
 *  - `transferring` — user clicked Transfer, PSBT being signed / broadcast.
 *  - `success` — broadcast OK; `successTxId` holds the txid.
 *  - `error` — something failed; `errorMessage` holds the reason.
 */
export type TransferState = 'idle' | 'loading-utxos' | 'ready' | 'transferring' | 'success' | 'error';

/**
 * High-level CAT-21 transfer flow. Mirrors `Cat21MintOrchestrator` in
 * shape so consumers can drive both flows with identical state-machine
 * templates.
 *
 * Singleton (`providedIn: 'root'`); state persists across route
 * navigations within a session. Auto-resets writable inputs when the
 * connected wallet changes — the cat UTXOs aren't visible to a
 * different wallet, the funding UTXOs are gone, and the recipient the
 * user typed for the previous wallet shouldn't quietly carry forward.
 */
@Injectable({ providedIn: 'root' })
export class Cat21TransferOrchestrator {
  private wallet = inject(WalletService);
  private cat21 = inject(Cat21Service);
  private network = inject(bitcoinNetwork);
  private fundingRec = inject(FundingRecommendationService);

  // --- Writable inputs ----------------------------------------------------

  /** Which cat the user picked from their gallery. */
  readonly catUtxo = signal<Cat21Holding | null>(null);

  /** Where the cat should go after the transfer. */
  readonly recipientAddress = signal<string | null>(null);

  /** sat/vB from the fee picker or manual input. */
  readonly feeRate = signal<number | null>(null);

  /**
   * User's explicit funding-UTXO pick from the picker (expert mode). When
   * null the orchestrator uses the SAFE auto-recommendation
   * (`fundingRecommendation$`): a content-clean best-fit covering UTXO when
   * one exists (`status: 'auto'`, invisible default), otherwise no auto-pick
   * (`status: 'expert-required'` — the UI must surface the picker so the user
   * consciously spends an asset-carrying coin). Setting this here is the
   * expert-mode override: the user's pick is honoured even if it carries
   * assets, because they chose it deliberately.
   */
  readonly selectedFundingUtxo = signal<TxnOutput | null>(null);

  // --- Internals (declared up here because instance-field initialisers
  // below depend on them at class-construction time).
  private lastWalletAddress: string | null = null;
  private readonly catUtxoSubject = new BehaviorSubject<Cat21Holding | null>(null);
  private readonly feeRateSubject = new BehaviorSubject<number | null>(null);
  private readonly selectedFundingUtxoSubject = new BehaviorSubject<TxnOutput | null>(null);
  // The recipient's script type changes the transfer's output vsize (P2TR
  // vs P2WPKH vs legacy), so the quoted fee depends on it. simulation$ must
  // re-fire when the recipient changes, hence a subject alongside the signal.
  private readonly recipientAddressSubject = new BehaviorSubject<string | null>(null);

  // --- Output state -------------------------------------------------------

  readonly state = signal<TransferState>('idle');
  readonly errorMessage = signal<string | null>(null);
  readonly successTxId = signal<string | null>(null);

  /** Currently connected wallet bridged to a signal for template reads. */
  readonly connectedWallet = toSignal(this.wallet.connectedWallet$, { initialValue: null });

  /** Convenience computed for `state() === 'ready'` gating. */
  readonly isReady = computed(() => this.state() === 'ready');

  /**
   * Auto-reset form fields when the wallet changes. Field-init order
   * matters: this subscription is declared BEFORE `fundingUtxos$` so
   * that `walletSubject.next(...)` notifies this handler FIRST,
   * clearing form state, and only then propagates through the loading
   * chain. Reverse order causes the form-reset to wipe a freshly-set
   * error message that the UTXO-fetch error path just wrote.
   *
   * Only the FORM is reset — not `errorMessage` or `successTxId`.
   * Operation-result state is owned by `transfer()` and `reset()`,
   * not by wallet-change events.
   */
  private readonly walletChangeSub: Subscription = this.wallet.connectedWallet$.subscribe((w) => {
    if (!w) {
      // Wallet disconnected — only reset if a wallet was previously
      // connected. The very first `null` emission (BehaviorSubject's
      // initial value before the user connects) has nothing to clear.
      if (this.lastWalletAddress !== null) {
        this.resetFormFields();
      }
      this.lastWalletAddress = null;
      return;
    }
    // Same-wallet re-emission (BehaviorSubject replay etc.) — leave
    // form intact. First-connect (lastWalletAddress === null) also
    // skips the reset; the user may have set the form already.
    if (this.lastWalletAddress === null || this.lastWalletAddress === w.ordinalsAddress) {
      this.lastWalletAddress = w.ordinalsAddress;
      return;
    }
    this.lastWalletAddress = w.ordinalsAddress;
    this.resetFormFields();
  });

  // --- Derived streams ----------------------------------------------------

  /**
   * Funding UTXOs for the connected wallet's payment address, with
   * the cat-bearing UTXO filtered out (we MUST NOT spend the cat as
   * funding — it has to ride input 0 of the transfer tx and end up
   * at output 0). Re-fetches on wallet change.
   */
  readonly fundingUtxos$: Observable<TxnOutput[]> = combineLatest([
    this.wallet.connectedWallet$.pipe(startWith(null as WalletInfo | null)),
    this.catUtxoSubject,
  ]).pipe(
    switchMap(([w, cat]) => {
      if (!w) {
        this.state.set('idle');
        return of([] as TxnOutput[]);
      }
      this.state.set('loading-utxos');
      return this.cat21.getUtxos(w.paymentAddress).pipe(
        map((utxos) => {
          if (!cat) return utxos;
          return utxos.filter((u) => !(u.txid === cat.txid && u.vout === cat.vout));
        }),
        tap(() => this.state.set('ready')),
        catchError((err: unknown) => {
          this.errorMessage.set(
            `Failed to load funding UTXOs: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.state.set('error');
          return of([] as TxnOutput[]);
        }),
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * Pass-through of the SDK's polled fee tiers. Mirrors mint's API.
   */
  readonly recommendedFees$: Observable<RecommendedFees> = this.cat21.recommendedFees$;

  /**
   * The funding target that the coin-selection safety check must cover. A
   * transfer preserves the cat UTXO (output 0 = `cat.value`), so the funding
   * pays ONLY the miner fee; the target is a generous ~200 vB fee ceiling (the
   * two-pass simulation tightens the real fee later). Null while no fee rate is
   * set, which makes the recommendation `insufficient` until the user picks a
   * rate.
   */
  private readonly fundingTarget$: Observable<number | null> = this.feeRateSubject.pipe(
    map((rate) => (rate && rate > 0 ? Math.ceil(rate * 200) : null)),
  );

  /**
   * SAFE-by-default coin-selection recommendation for the transfer's funding
   * (shared brain, identical across mint / transfer / offer / inscribe). Emits
   * `auto` (a content-clean coin covers → auto-selected, no picker needed),
   * `expert-required` (only asset-bearing coins cover → the UI must surface the
   * picker with the recommended coin pre-highlighted), `scanning`, or
   * `insufficient`. The UI branches on `.status` to decide whether to show the
   * picker; the invisible default is `auto`.
   */
  readonly fundingRecommendation$: Observable<
    FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>
  > = this.fundingRec.recommend<TxnOutput>(this.fundingUtxos$, this.fundingTarget$).pipe(
    catchError(() =>
      of<FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>>({
        status: 'insufficient',
        recommended: null,
        candidates: [],
      }),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * Best-funding-UTXO + two-pass-fee simulation for the current
   * (cat, funding recommendation, recipient, feeRate) tuple. Re-emits when any
   * of those change. `insufficient: true` when no funding UTXO covers the fee.
   * The funding coin comes from the user's expert-mode pick when set, else the
   * SAFE auto-recommendation (only when `status: 'auto'`) — never a
   * content-unaware value-only pick.
   */
  readonly simulation$: Observable<TransferSimulationOutcome> = combineLatest([
    this.fundingRecommendation$,
    this.wallet.connectedWallet$.pipe(startWith(null as WalletInfo | null)),
    this.catUtxoSubject,
    this.feeRateSubject,
    this.selectedFundingUtxoSubject,
    this.recipientAddressSubject,
  ]).pipe(
    // computeSimulation reads the recipient from its signal (set synchronously
    // in setRecipientAddress before the subject emits, so it's current here);
    // the recipient source is present to RE-FIRE the stream on recipient change.
    map(([recommendation, wallet, cat, feeRate, selected]) =>
      this.computeSimulation(recommendation, wallet, cat, feeRate, selected),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // --- Commands -----------------------------------------------------------

  setCatUtxo(cat: Cat21Holding | null): void {
    this.catUtxo.set(cat);
    this.catUtxoSubject.next(cat);
  }

  setRecipientAddress(address: string | null): void {
    const value = address && address.trim() ? address.trim() : null;
    this.recipientAddress.set(value);
    this.recipientAddressSubject.next(value);
  }

  setFeeRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.feeRate.set(rate);
    this.feeRateSubject.next(rate);
  }

  /**
   * Push the user's funding-UTXO pick (or null to fall back to
   * auto-pick). The picker UI calls this every time the seller clicks
   * a row in the scanner-annotated funding list.
   */
  setSelectedFundingUtxo(utxo: TxnOutput | null): void {
    this.selectedFundingUtxo.set(utxo);
    this.selectedFundingUtxoSubject.next(utxo);
  }

  /**
   * Trigger the transfer. Requires a connected wallet, a selected cat,
   * a recipient address, a fee rate, and a fundable funding UTXO.
   * Builds the PSBT, signs at both addresses, broadcasts.
   *
   * State transitions: ready → transferring → success | error.
   */
  transfer(
    // Watch-only (xpub) wallets sign via this export/paste bridge; injected
    // wallets ignore it. A watch-only transfer throws without it.
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Observable<string>,
  ): Observable<{ txId: string }> {
    const wallet = this.connectedWallet();
    const cat = this.catUtxo();
    const recipient = this.recipientAddress();
    const feeRate = this.feeRate();

    if (!wallet) return throwError(() => new Error('No wallet connected'));
    if (!cat) return throwError(() => new Error('No cat selected'));
    if (!recipient) return throwError(() => new Error('No recipient address'));
    if (!feeRate) return throwError(() => new Error('No fee rate set'));

    // Snapshot the latest derived simulation so we can ensure the
    // fee + funding UTXO match what we'll actually broadcast.
    let simulationOutcome: TransferSimulationOutcome;
    try {
      simulationOutcome = this.computeSimulation(
        // Sync snapshot of the safe funding recommendation (the async scan has
        // resolved by the time Transfer is clickable — the UI gates the button
        // on a present simulation). Re-running the calc here guarantees the
        // broadcast uses the exact coin the preview showed.
        this.lastRecommendationSnapshot,
        wallet,
        cat,
        feeRate,
        this.selectedFundingUtxo(),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(msg);
      this.state.set('error');
      return throwError(() => err);
    }

    if (simulationOutcome.insufficient || !simulationOutcome.simulation) {
      // Distinguish a genuine shortfall from "there's money, but only on a
      // valuable coin" (expert-required) or "scans still resolving" — a flat
      // "insufficient funds" would misreport the last two.
      let msg: string;
      if (simulationOutcome.insufficient) {
        msg = 'Insufficient funds for transfer at the current fee rate';
      } else if (this.lastRecommendationSnapshot.status === 'expert-required') {
        msg = 'Select a funding UTXO (the available coins carry assets)';
      } else {
        msg = 'Still checking your coins for assets, one moment';
      }
      this.errorMessage.set(msg);
      this.state.set('error');
      return throwError(() => new Error(msg));
    }

    const { simulation } = simulationOutcome;

    this.state.set('transferring');
    this.errorMessage.set(null);
    this.successTxId.set(null);

    try {
      const psbtBytes = this.buildTransferPsbt(wallet, cat, recipient, simulation);
      const signer = findSignerOrThrow(wallet.type);

      return signer.signTransfer({
        psbtBytes,
        ordinalsAddress: wallet.ordinalsAddress,
        paymentAddress: wallet.paymentAddress,
        fundingInputCount: 1,
        network: this.network,
        broadcast: (txHex) => this.cat21.postTransaction(txHex),
        promptForSignedPsbt,
      }).pipe(
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(msg);
      this.state.set('error');
      return throwError(() => err);
    }
  }

  /**
   * Wipe writables AND operation-result state back to a fresh
   * transfer (typically the "Transfer another" button on success).
   * Keeps the wallet connected.
   */
  reset(): void {
    this.resetFormFields();
    this.errorMessage.set(null);
    this.successTxId.set(null);
    this.state.set(this.connectedWallet() ? 'ready' : 'idle');
  }

  // --- Internals ----------------------------------------------------------

  /**
   * Latest snapshot of the safe funding recommendation maintained by the
   * `fundingRecommendation$` subscription. Lets `transfer()` synchronously
   * re-compute the simulation against the most recent recommendation (the
   * clean auto-pick + full candidate list) without juggling RxJS take(1).
   */
  private lastRecommendationSnapshot: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
    status: 'insufficient',
    recommended: null,
    candidates: [],
  };

  private readonly recommendationSnapshotSub = this.fundingRecommendation$.subscribe((r) => {
    this.lastRecommendationSnapshot = r;
  });

  private resetFormFields(): void {
    this.catUtxo.set(null);
    this.catUtxoSubject.next(null);
    this.recipientAddress.set(null);
    this.recipientAddressSubject.next(null);
    this.feeRate.set(null);
    this.feeRateSubject.next(null);
    this.selectedFundingUtxo.set(null);
    this.selectedFundingUtxoSubject.next(null);
  }

  private computeSimulation(
    recommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>,
    wallet: WalletInfo | null,
    cat: Cat21Holding | null,
    feeRate: number | null,
    selected: TxnOutput | null = null,
  ): TransferSimulationOutcome {
    if (!wallet || !cat || !feeRate) {
      return { simulation: null, insufficient: false };
    }
    // GOLDEN RULE: the cat UTXO is preserved (output 0 = cat.value, funded by
    // the cat input itself), so the funding must cover ONLY the miner fee.
    // Use a generous fee over-estimate in the pick stage; the two-pass
    // simulation below tightens it.
    const target = Math.ceil(feeRate * 200); // ~200 vB ceiling for transfer
    // Expert-mode override: the user's explicit pick wins when it still covers
    // the target, even if it carries assets (they chose it deliberately).
    // Otherwise use the SAFE auto-recommendation — but ONLY when a content-clean
    // coin covers (`status: 'auto'`). When only asset coins cover
    // (`expert-required`) or a scan is still resolving (`scanning`), there is no
    // safe auto-pick: the simulation stays null and the UI surfaces the picker
    // (via `fundingRecommendation$`). This is the "never auto-spend a valuable
    // coin" guarantee, enforced at the orchestrator, shared by every flow.
    const selectedStillPresent = selected
      ? recommendation.candidates.find((u) => u.txid === selected.txid && u.vout === selected.vout)
      : undefined;
    const pick: TxnOutput | null =
      selectedStillPresent && selectedStillPresent.value >= target
        ? selectedStillPresent
        : recommendation.status === 'auto'
          ? recommendation.recommended
          : null;
    if (!pick) {
      return { simulation: null, insufficient: recommendation.status === 'insufficient' };
    }

    try {
      const { vsize, finalFeeSats } = twoPassFeeSimulation({
        simulate: (feeSats) => this.simulateTransfer(wallet, cat, pick, feeSats),
        feeRatePerVbyte: feeRate,
        // Seed pass-1 with the SAME fee budget the coin was selected against
        // (`target`), not the flat 1000-sat default. The picked coin covers
        // `target` by construction, so pass-1 always builds; a flat 1000 would
        // falsely reject a small-but-viable clean coin at low fee rates.
        placeholderFeeSats: target,
      });
      // GOLDEN RULE: the cat UTXO is preserved (output 0 = cat.value), so the
      // funding pays ONLY the fee — change = funding - fee (the cat's sats all
      // went to output 0 untouched). Mirror the builder's dust rule: sub-dust
      // change is absorbed into the miner fee (no change output emitted), so
      // report 0 rather than a "you'll get N sats" figure that never lands.
      const changeRaw = pick.value - finalFeeSats;
      let changeDustLimit: number;
      try {
        changeDustLimit = getMinimumUtxoSize(wallet.paymentAddress);
      } catch {
        changeDustLimit = CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS;
      }
      const changeSats = changeRaw >= changeDustLimit ? changeRaw : 0;
      return {
        simulation: {
          vsize,
          feeSats: finalFeeSats,
          changeSats,
          fundingUtxo: pick,
        },
        insufficient: false,
      };
    } catch {
      return { simulation: null, insufficient: true };
    }
  }

  /**
   * Build a dummy-signed transfer PSBT for fee/vsize measurement.
   * Uses the wallet's real public keys + addresses + script types
   * (so the witness shape and vsize match the real broadcast) but a
   * dummy fee placeholder per `twoPassFeeSimulation`'s contract.
   */
  private simulateTransfer(
    wallet: WalletInfo,
    cat: Cat21Holding,
    funding: TxnOutput,
    feeSats: number,
  ): { vsize: number } {
    const catInput: Cat21TransferCatInput = prepareTransferCatInput({
      utxo: { txid: cat.txid, vout: cat.vout, value: cat.value, status: { confirmed: true } },
      paymentPublicKey: hex.decode(wallet.ordinalsPublicKey),
      paymentAddress: wallet.ordinalsAddress,
      isSimulation: true,
      network: this.network as Network,
    });
    const fundingInput: Cat21TransferFundingInput = prepareTransferFundingInput({
      utxo: funding,
      paymentPublicKey: hex.decode(wallet.paymentPublicKey),
      paymentAddress: wallet.paymentAddress,
      isSimulation: true,
      network: this.network as Network,
    });

    const built = buildCat21TransferPsbt({
      walletType: wallet.type,
      network: this.network as Network,
      catUtxo: catInput,
      fundingInputs: [fundingInput],
      destinations: {
        recipientAddress: this.recipientAddress() ?? wallet.paymentAddress,
        senderChangeAddress: wallet.paymentAddress,
      },
      feeSats,
    });

    return {
      vsize: computePsbtVsize({
        psbt: built.psbt,
        network: toScureNetwork(this.network as Network),
      }),
    };
  }

  /**
   * Build the REAL unsigned transfer PSBT, using the pass-2 fee from
   * `simulation`. Caller hands the bytes to the wallet for signing.
   */
  private buildTransferPsbt(
    wallet: WalletInfo,
    cat: Cat21Holding,
    recipient: string,
    simulation: TransferSimulation,
  ): Uint8Array {
    const catInput: Cat21TransferCatInput = prepareTransferCatInput({
      utxo: { txid: cat.txid, vout: cat.vout, value: cat.value, status: { confirmed: true } },
      paymentPublicKey: hex.decode(wallet.ordinalsPublicKey),
      paymentAddress: wallet.ordinalsAddress,
      isSimulation: false,
      network: this.network as Network,
    });
    const fundingInput: Cat21TransferFundingInput = prepareTransferFundingInput({
      utxo: simulation.fundingUtxo,
      paymentPublicKey: hex.decode(wallet.paymentPublicKey),
      paymentAddress: wallet.paymentAddress,
      isSimulation: false,
      network: this.network as Network,
    });

    const built = buildCat21TransferPsbt({
      walletType: wallet.type,
      network: this.network as Network,
      catUtxo: catInput,
      fundingInputs: [fundingInput],
      destinations: {
        recipientAddress: recipient,
        senderChangeAddress: wallet.paymentAddress,
      },
      feeSats: simulation.feeSats,
    });

    return built.psbt;
  }
}
