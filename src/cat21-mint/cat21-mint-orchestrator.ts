import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import { ContentScanPort, CoreFundingUtxo } from '../cat21-core/ports';
import { MintCoreParams, simulateMint } from '../cat21-core/mint.core';
import { resolveCatTxFee } from '../cat21-fee/resolve-cat-tx-fee.helper';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  liftRecommendationByOutpoint,
} from '../cat21-fee/funding-safety';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Network } from '../network';
import { findSignerOrThrow } from '../wallet/signers';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { createTransaction, simulateMintTransaction } from './cat21.service.helper';
import { SimulateTransactionResult, TxnOutput } from './cat21.service.types';

/**
 * FRAMEWORK-AGNOSTIC high-level mint API. Plain class — no Angular, no
 * `@Injectable`, no signals. The SDK owns this orchestration; a consumer
 * IMPORTS it ready-made and binds its `subscribe(listener)` callback to
 * whatever reactivity it uses in ONE line (`orch.subscribe(s => sig.set(s))`).
 * The orchestrator wires wallet-backed signing internally (the signer
 * registry) and the fee/selection/build logic (the shared helpers + the
 * force-scanning `selectFunding`); the consumer supplies only the I/O it
 * owns (electrs/ord/broadcast) as the `MintOrchestratorDeps` callbacks and
 * the connected wallet via `setWallet`.
 *
 * The Angular `Cat21MintOrchestrator` (`cat21-mint-orchestrator.service.ts`)
 * is a parallel Angular-signal implementation that composes the same
 * lower-level helpers (`createTransaction` / `simulateMintTransaction` /
 * `selectFunding`); the two do not share this class.
 */

/** State machine the UI branches on. */
export type MintOrchestratorState =
  | 'idle' | 'loading-utxos' | 'ready' | 'minting' | 'success' | 'error';

/** One row in the per-UTXO simulation grid (the expert picker). */
export interface UtxoSimulationRow {
  utxo: TxnOutput;
  simulation: SimulateTransactionResult | null;
  insufficient: boolean;
}

/** The connected wallet's addresses + type; the consumer supplies it. */
export interface MintWalletContext {
  type: KnownOrdinalWalletType;
  ordinalsAddress: string;
  paymentAddress: string;
  /** hex-encoded payment public key. */
  paymentPublicKey: string;
}

/** I/O the orchestrator delegates to the consumer's infra — all plain async. */
export interface MintOrchestratorDeps {
  /** Spendable UTXOs at the payment address (electrs). */
  getUtxos(paymentAddress: string): Promise<TxnOutput[]>;
  /** Content classification for the force-scan funding safety (ord + cat21-ord). */
  scan: ContentScanPort;
  /** Broadcast a signed tx hex; resolves to the txid. */
  broadcast(signedTxHex: string): Promise<string>;
  network: Network;
}

/** Everything a consumer template needs, emitted on every state change. */
export interface MintSnapshot {
  state: MintOrchestratorState;
  feeRate: number | null;
  selectedUtxo: TxnOutput | null;
  fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
  simulations: UtxoSimulationRow[];
  errorMessage: string | null;
  successTxId: string | null;
}

const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'insufficient',
  recommended: null,
  candidates: [],
};

export class Cat21MintOrchestrator {
  private wallet: MintWalletContext | null = null;
  private utxos: TxnOutput[] = [];
  // Monotonic guard: a setter/wallet-change bumps this; an in-flight async
  // recompute whose captured seq is stale drops its result instead of
  // overwriting a newer snapshot (the plain-class replacement for switchMap).
  private recomputeSeq = 0;
  private snap: MintSnapshot = {
    state: 'idle',
    feeRate: null,
    selectedUtxo: null,
    fundingRecommendation: EMPTY_RECOMMENDATION,
    simulations: [],
    errorMessage: null,
    successTxId: null,
  };
  private readonly listeners = new Set<(s: MintSnapshot) => void>();

  constructor(private readonly deps: MintOrchestratorDeps) {}

  /** Synchronous snapshot read. */
  getSnapshot(): MintSnapshot {
    return this.snap;
  }

  /**
   * Subscribe to snapshot changes. Fires immediately with the current
   * snapshot, then on every change. Returns an unsubscribe fn. A consumer
   * binds this to its reactivity in one line.
   */
  subscribe(listener: (s: MintSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snap);
    return () => this.listeners.delete(listener);
  }

  /**
   * Set (or clear) the connected wallet. On a genuine wallet change, resets
   * form state, fetches the new wallet's UTXOs, and recomputes.
   */
  async setWallet(wallet: MintWalletContext | null): Promise<void> {
    const changed = (this.wallet?.ordinalsAddress ?? null) !== (wallet?.ordinalsAddress ?? null);
    this.wallet = wallet;
    this.recomputeSeq++; // invalidate any in-flight recompute from the old wallet
    if (changed) {
      this.patch({ feeRate: null, selectedUtxo: null, errorMessage: null, successTxId: null });
    }
    if (!wallet) {
      this.utxos = [];
      this.patch({ state: 'idle', simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    this.patch({ state: 'loading-utxos' });
    try {
      this.utxos = await this.deps.getUtxos(wallet.paymentAddress);
      this.patch({ state: 'ready' });
    } catch (err) {
      this.utxos = [];
      this.patch({ state: 'error', errorMessage: `Failed to load UTXOs: ${errMsg(err)}` });
      return;
    }
    await this.recompute();
  }

  setFeeRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.patch({ feeRate: rate });
    void this.recompute();
  }

  setSelectedUtxo(utxo: TxnOutput | null): void {
    this.patch({ selectedUtxo: utxo });
  }

  /**
   * Execute the mint: pick (explicit override, else the safe auto-clean
   * recommendation — never an asset coin unless the user chose it), two-pass
   * fee, build, and sign+broadcast via the wallet's internal signer. Browser
   * wallets sign-and-broadcast in one call; watch-only wallets bridge through
   * `promptForSignedPsbt`.
   */
  async mint(
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Promise<string>,
  ): Promise<{ txId: string }> {
    const wallet = this.wallet;
    const feeRate = this.snap.feeRate;
    const rec = this.snap.fundingRecommendation;
    const selected: TxnOutput | null =
      this.snap.selectedUtxo ?? (rec.status === 'auto' ? rec.recommended : null);

    if (!wallet) throw new Error('No wallet connected');
    if (!feeRate) throw new Error('No fee rate set');
    if (!selected) {
      throw new Error(
        rec.status === 'expert-required'
          ? 'Select a funding UTXO (the available coins carry assets)'
          : 'No UTXO selected',
      );
    }

    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    const resolved = this.resolveFee(wallet, selected, paymentPublicKey, feeRate);
    if (!resolved) {
      const msg = 'Insufficient funds for the mint at the current fee rate';
      this.patch({ state: 'error', errorMessage: msg });
      throw new Error(msg);
    }
    const transactionFee = BigInt(resolved.finalFeeSats);

    this.patch({ state: 'minting', errorMessage: null, successTxId: null });
    try {
      const { tx } = createTransaction(
        wallet.type,
        wallet.ordinalsAddress,
        selected,
        paymentPublicKey,
        wallet.paymentAddress,
        transactionFee,
        false,
        this.deps.network,
      );
      const signer = findSignerOrThrow(wallet.type);
      const { txId } = await firstValueFrom(
        signer.signSingleFundingInput({
          psbtBytes: tx.toPSBT(0),
          paymentAddress: wallet.paymentAddress,
          paymentPublicKey: wallet.paymentPublicKey,
          network: this.deps.network,
          broadcast: (txHex: string) => from(this.deps.broadcast(txHex)),
          promptForSignedPsbt: promptForSignedPsbt
            ? (unsigned) => from(promptForSignedPsbt(unsigned))
            : undefined,
        }),
      );
      this.patch({ state: 'success', successTxId: txId });
      return { txId };
    } catch (err) {
      this.patch({ state: 'error', errorMessage: errMsg(err) });
      throw err;
    }
  }

  /** "Mint another" — wipe form state, keep the wallet. */
  reset(): void {
    this.patch({
      feeRate: null,
      selectedUtxo: null,
      simulations: [],
      fundingRecommendation: EMPTY_RECOMMENDATION,
      errorMessage: null,
      successTxId: null,
      state: this.wallet ? 'ready' : 'idle',
    });
  }

  // --- internals ----------------------------------------------------------

  private async recompute(): Promise<void> {
    const seq = ++this.recomputeSeq;
    const wallet = this.wallet;
    const feeRate = this.snap.feeRate;
    if (!wallet || !feeRate || this.utxos.length === 0) {
      this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    // Per-UTXO grid (no core twin — the expert picker's fee breakdown). Each
    // row's fee is resolved guess-free (measured vsize, no-change fallback).
    const simulations = this.utxos.map<UtxoSimulationRow>((utxo) => {
      const resolved = this.resolveFee(wallet, utxo, paymentPublicKey, feeRate);
      return resolved
        ? { utxo, simulation: { ...resolved.sim, finalTransactionFee: BigInt(resolved.finalFeeSats) }, insufficient: false }
        : { utxo, simulation: null, insufficient: true };
    });
    // Safe-auto recommendation: delegate to mint.core's `simulateMint` (the
    // guess-free target + content-scan selection, single source of truth), then
    // lift its CoreFundingUtxo picks back into the TxnOutput domain by outpoint.
    let fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = EMPTY_RECOMMENDATION;
    try {
      const mintSim = await simulateMint(this.mintParams(wallet, paymentPublicKey, feeRate), {
        utxos: this.utxosPort(),
        scan: this.deps.scan,
      });
      fundingRecommendation = liftRecommendationByOutpoint(mintSim.recommendation, this.utxos);
    } catch {
      fundingRecommendation = EMPTY_RECOMMENDATION;
    }
    if (seq !== this.recomputeSeq) return; // a newer input superseded this run
    this.patch({ simulations, fundingRecommendation });
  }

  /**
   * Guess-free realised fee for one funding coin, or null when it can't mint at
   * the fee rate. Measures the with-change form and falls back to no-change /
   * absorb, so a coin that genuinely fits is never rejected.
   */
  private resolveFee(
    wallet: MintWalletContext,
    utxo: TxnOutput,
    paymentPublicKey: Uint8Array,
    feeRate: number,
  ): { sim: SimulateTransactionResult; vsize: number; finalFeeSats: number } | null {
    const budget = utxo.value - CAT21_POSTAGE_SATS;
    if (budget < 0) return null;
    return resolveCatTxFee({
      simulate: (feeSats) => {
        const sim = simulateMintTransaction(
          wallet.type,
          wallet.ordinalsAddress,
          utxo,
          wallet.paymentAddress,
          paymentPublicKey,
          BigInt(feeSats),
          this.deps.network,
        );
        return { sim, vsize: sim.vsize, finalFeeSats: Number(sim.finalTransactionFee) };
      },
      feeRatePerVbyte: feeRate,
      feeBudgetSats: budget,
    });
  }

  private mintParams(wallet: MintWalletContext, paymentPublicKey: Uint8Array, feeRate: number): MintCoreParams {
    return {
      walletType: wallet.type,
      network: this.deps.network,
      paymentPublicKey,
      paymentAddress: wallet.paymentAddress,
      recipientAddress: wallet.ordinalsAddress,
      feeRatePerVbyte: feeRate,
      selectedFundingUtxo: this.snap.selectedUtxo ? toCore(this.snap.selectedUtxo) : undefined,
    };
  }

  private utxosPort() {
    const utxos = this.utxos;
    return { spendableUtxos: async (): Promise<CoreFundingUtxo[]> => utxos.map(toCore) };
  }

  private patch(next: Partial<MintSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of this.listeners) l(this.snap);
  }
}

function toCore(u: TxnOutput): CoreFundingUtxo {
  return { txid: u.txid, vout: u.vout, value: u.value, transactionHex: u.transactionHex };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
