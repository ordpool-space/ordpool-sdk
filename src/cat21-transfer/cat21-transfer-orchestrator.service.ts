import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
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

import {
  pickLargestFundingUtxoThatCovers,
  type FundingUtxo,
} from '../cat21-fee/coin-selection.helper';
import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { RecommendedFees, TxnOutput } from '../cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../network';
import { bitcoinNetwork } from '../network-token';
import { findSignerOrThrow } from '../wallet/signers';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { buildCat21TransferPsbt } from './cat21-transfer.helper';
import {
  prepareTransferCatInput,
  prepareTransferFundingInput,
} from './cat21-transfer-input-adapter';
import {
  Cat21TransferCatInput,
  Cat21TransferFundingInput,
} from './cat21-transfer.types';

/**
 * Identifies a cat the connected wallet currently owns. Consumer (the
 * cat21.space frontend or any other) populates this from its existing
 * "show me my cats" lookup (ord by ordinals address → list of cat
 * inscriptions → the UTXO each cat sits on).
 *
 * `vout` and `value` are intrinsic to CAT-21 (FIFO at output 0, 546
 * sats) but we carry them on the type so the orchestrator is self-
 * contained and a future protocol change wouldn't break the call
 * shape silently.
 */
export interface Cat21Holding {
  catNumber: number;
  txid: string;
  vout: number;
  /** Always 546 sats for a CAT-21 cat UTXO. */
  value: number;
}

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

  // --- Writable inputs ----------------------------------------------------

  /** Which cat the user picked from their gallery. */
  readonly catUtxo = signal<Cat21Holding | null>(null);

  /** Where the cat should go after the transfer. */
  readonly recipientAddress = signal<string | null>(null);

  /** sat/vB from the fee picker or manual input. */
  readonly feeRate = signal<number | null>(null);

  // --- Internals (declared up here because instance-field initialisers
  // below depend on them at class-construction time).
  private lastWalletAddress: string | null = null;
  private readonly catUtxoSubject = new BehaviorSubject<Cat21Holding | null>(null);
  private readonly feeRateSubject = new BehaviorSubject<number | null>(null);

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
   * Best-funding-UTXO + two-pass-fee simulation for the current
   * (cat, fundingUtxos, recipient, feeRate) tuple. Re-emits when any
   * of those change. `insufficient: true` when no funding UTXO covers
   * `postage + fee`.
   */
  readonly simulation$: Observable<TransferSimulationOutcome> = combineLatest([
    this.fundingUtxos$,
    this.wallet.connectedWallet$.pipe(startWith(null as WalletInfo | null)),
    this.catUtxoSubject,
    this.feeRateSubject,
  ]).pipe(
    map(([fundingUtxos, wallet, cat, feeRate]) =>
      this.computeSimulation(fundingUtxos, wallet, cat, feeRate),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // --- Commands -----------------------------------------------------------

  setCatUtxo(cat: Cat21Holding | null): void {
    this.catUtxo.set(cat);
    this.catUtxoSubject.next(cat);
  }

  setRecipientAddress(address: string | null): void {
    this.recipientAddress.set(address && address.trim() ? address.trim() : null);
  }

  setFeeRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.feeRate.set(rate);
    this.feeRateSubject.next(rate);
  }

  /**
   * Trigger the transfer. Requires a connected wallet, a selected cat,
   * a recipient address, a fee rate, and a fundable funding UTXO.
   * Builds the PSBT, signs at both addresses, broadcasts.
   *
   * State transitions: ready → transferring → success | error.
   */
  transfer(): Observable<{ txId: string }> {
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
        // Latest fundingUtxos value (one-shot read via take(1) on a
        // shared replay is the right shape, but we want a sync value
        // here. The simulation stream already pre-computes — reuse it
        // by re-running the calc against a sync snapshot of the
        // funding UTXOs).
        this.lastFundingUtxosSnapshot,
        wallet,
        cat,
        feeRate,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(msg);
      this.state.set('error');
      return throwError(() => err);
    }

    if (simulationOutcome.insufficient || !simulationOutcome.simulation) {
      const msg = 'Insufficient funds for transfer at the current fee rate';
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
      }).pipe(
        tap(({ txId }) => {
          this.successTxId.set(txId);
          this.state.set('success');
        }),
        catchError((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error('[cat21-transfer-flow-error]', msg, err);
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
   * Latest snapshot of the funding UTXO list maintained by the
   * `fundingUtxos$` subscription. Lets `transfer()` synchronously
   * re-compute the simulation against the most recent UTXO set
   * without juggling RxJS take(1).
   */
  private lastFundingUtxosSnapshot: TxnOutput[] = [];

  private readonly fundingUtxosSnapshotSub = this.fundingUtxos$.subscribe((u) => {
    this.lastFundingUtxosSnapshot = u;
  });

  private resetFormFields(): void {
    this.catUtxo.set(null);
    this.catUtxoSubject.next(null);
    this.recipientAddress.set(null);
    this.feeRate.set(null);
    this.feeRateSubject.next(null);
  }

  private computeSimulation(
    fundingUtxos: TxnOutput[],
    wallet: WalletInfo | null,
    cat: Cat21Holding | null,
    feeRate: number | null,
  ): TransferSimulationOutcome {
    // eslint-disable-next-line no-console
    console.log('[cat21-transfer-sim] enter fundingUtxos.length=', fundingUtxos.length,
      'walletType=', wallet?.type, 'catTxid=', cat?.txid, 'feeRate=', feeRate);
    if (!wallet || !cat || !feeRate || fundingUtxos.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[cat21-transfer-sim] guard hit — returning insufficient=false');
      return { simulation: null, insufficient: false };
    }
    // The transfer needs `postage (546) + fee` covered by the funding
    // UTXO (the cat UTXO itself contributes 546 sats but those flow
    // back out at output 0 to the recipient — they don't fund the fee).
    // Use a generous over-estimate for fee+postage in the pick stage;
    // the two-pass simulation below tightens it.
    const target = CAT21_POSTAGE_SATS + Math.ceil(feeRate * 200); // ~200 vB ceiling for transfer
    const pick = pickLargestFundingUtxoThatCovers<TxnOutput & FundingUtxo>({
      utxos: fundingUtxos as ReadonlyArray<TxnOutput & FundingUtxo>,
      targetSpendSats: target,
    });
    // eslint-disable-next-line no-console
    console.log('[cat21-transfer-sim] target=', target, 'pick=', pick
      ? `${pick.txid}:${pick.vout} value=${pick.value}` : 'null');
    if (!pick) {
      // eslint-disable-next-line no-console
      console.log('[cat21-transfer-sim] pick=null — returning insufficient=true');
      return { simulation: null, insufficient: true };
    }

    try {
      const { vsize, finalFeeSats } = twoPassFeeSimulation({
        simulate: (feeSats) => this.simulateTransfer(wallet, cat, pick, feeSats),
        feeRatePerVbyte: feeRate,
      });
      const totalIn = CAT21_POSTAGE_SATS + pick.value;
      const changeSats = Math.max(0, totalIn - CAT21_POSTAGE_SATS - finalFeeSats);
      return {
        simulation: {
          vsize,
          feeSats: finalFeeSats,
          changeSats,
          fundingUtxo: pick,
        },
        insufficient: false,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[cat21-transfer-sim-error]', err);
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

    // Dummy-sign every input and finalise so tx.vsize is observable.
    // scure refuses `.vsize` on an unfinalised transaction ("Transaction
    // is not finalized"). We swap in the SDK dummy key (schnorr for the
    // Taproot cat input, ECDSA for P2WPKH funding inputs) so signatures
    // are structurally valid at the right length — vsize matches what a
    // real-signed tx would have within < 1 vB tolerance.
    const tx = btc.Transaction.fromPSBT(built.psbt);
    const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(this.network as Network));
    // sign() applies to every input the key can sign; SIGHASH_DEFAULT
    // covers taproot key-path, SIGHASH_ALL covers non-taproot.
    tx.sign(dummyPrivateKey, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
    tx.finalize();
    return { vsize: tx.vsize };
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
