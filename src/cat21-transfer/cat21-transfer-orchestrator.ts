import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import {
  buildTransfer,
  simulateTransfer,
  TransferCoreParams,
  TransferSimulationResult,
} from '../cat21-core/transfer.core';
import { ContentScanPort, CoreFundingUtxo } from '../cat21-core/ports';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  liftRecommendationByOutpoint,
} from '../cat21-fee/funding-safety';
import { Network } from '../network';
import { findSignerOrThrow } from '../wallet/signers';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { Cat21Holding } from './cat21-transfer.types';

/**
 * FRAMEWORK-AGNOSTIC high-level transfer API. Plain class. Owns
 * the transfer state machine; delegates the preview (content-checked funding
 * pick + two-pass fee + dust-absorb) to `transfer.core`'s `simulateTransfer`
 * and the build to `buildTransfer` (no duplication), and wires wallet-backed
 * sign+broadcast INTERNALLY via `findSignerOrThrow` (`signer.signTransfer`).
 * State ships through a plain `subscribe(listener)` callback; a consumer
 * imports it ready-made and binds in one line.
 *
 * The cat UTXO is preserved (output 0 = the whole cat value); funding covers
 * ONLY the miner fee (golden rule).
 */

export type TransferOrchestratorState =
  | 'idle' | 'loading-utxos' | 'ready' | 'transferring' | 'success' | 'error';

export interface TransferWalletContext {
  type: KnownOrdinalWalletType;
  ordinalsAddress: string;
  /** hex-encoded ordinals public key (signs the cat input). */
  ordinalsPublicKey: string;
  paymentAddress: string;
  /** hex-encoded payment public key (signs the funding inputs). */
  paymentPublicKey: string;
}

export interface TransferOrchestratorDeps {
  getUtxos(paymentAddress: string): Promise<TxnOutput[]>;
  scan: ContentScanPort;
  broadcast(signedTxHex: string): Promise<string>;
  network: Network;
}

export interface TransferSimulationView {
  feeSats: number;
  changeSats: number;
  fundingUtxo: CoreFundingUtxo;
  /** Output-0 size the build will emit (= the incoming cat value under PRESERVE, or the explicit targetPostageSats). */
  catOutputSats: number;
}

export interface TransferSnapshot {
  state: TransferOrchestratorState;
  catUtxo: Cat21Holding | null;
  recipientAddress: string | null;
  feeRate: number | null;
  selectedFundingUtxo: TxnOutput | null;
  /**
   * Optional cat-UTXO resize (GROW to rescue a sub-dust cat or
   * self-provision a cold wallet; SHRINK to trim a chunky one).
   * null = PRESERVE the incoming size (the golden-rule default).
   */
  targetPostageSats: number | null;
  // Candidates are lifted back to the consumer's TxnOutput domain (carrying
  // `status`, `transactionHex`, …) so a picker UI renders them directly.
  fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
  simulation: TransferSimulationView | null;
  errorMessage: string | null;
  successTxId: string | null;
}

const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'insufficient',
  recommended: null,
  candidates: [],
};

export class Cat21TransferOrchestrator {
  private wallet: TransferWalletContext | null = null;
  private utxos: TxnOutput[] = [];
  // Monotonic guard: a setter/wallet-change bumps this; an in-flight async
  // recompute whose captured seq is stale drops its result instead of
  // overwriting a newer snapshot (the plain-class replacement for switchMap).
  private recomputeSeq = 0;
  private snap: TransferSnapshot = {
    state: 'idle',
    catUtxo: null,
    recipientAddress: null,
    feeRate: null,
    selectedFundingUtxo: null,
    targetPostageSats: null,
    fundingRecommendation: EMPTY_RECOMMENDATION,
    simulation: null,
    errorMessage: null,
    successTxId: null,
  };
  private readonly listeners = new Set<(s: TransferSnapshot) => void>();

  constructor(private readonly deps: TransferOrchestratorDeps) {}

  getSnapshot(): TransferSnapshot {
    return this.snap;
  }

  subscribe(listener: (s: TransferSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snap);
    return () => this.listeners.delete(listener);
  }

  async setWallet(wallet: TransferWalletContext | null): Promise<void> {
    const changed = (this.wallet?.ordinalsAddress ?? null) !== (wallet?.ordinalsAddress ?? null);
    this.wallet = wallet;
    this.recomputeSeq++; // invalidate any in-flight recompute from the old wallet
    if (changed) {
      this.patch({
        catUtxo: null, recipientAddress: null, feeRate: null, selectedFundingUtxo: null,
        targetPostageSats: null, errorMessage: null, successTxId: null,
      });
    }
    if (!wallet) {
      this.utxos = [];
      this.patch({ state: 'idle', simulation: null, fundingRecommendation: EMPTY_RECOMMENDATION });
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

  setCatUtxo(cat: Cat21Holding | null): void {
    this.patch({ catUtxo: cat });
    void this.recompute();
  }

  setRecipientAddress(recipient: string | null): void {
    this.patch({ recipientAddress: recipient });
    void this.recompute();
  }

  setFeeRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.patch({ feeRate: rate });
    void this.recompute();
  }

  setSelectedFundingUtxo(utxo: TxnOutput | null): void {
    this.patch({ selectedFundingUtxo: utxo });
    void this.recompute();
  }

  /**
   * Opt-in cat-UTXO resize. A positive value GROWs (pad output 0 up to the
   * target: rescue a sub-dust cat, or self-provision a cold wallet) or
   * SHRINKs (trim a chunky cat, surplus self-funds the fee) — the builder
   * enforces the recipient's dust floor on any explicit target. null
   * restores the PRESERVE default (output 0 = the incoming cat value).
   */
  setTargetPostageSats(sats: number | null): void {
    if (sats !== null && (!Number.isFinite(sats) || sats <= 0)) return;
    this.patch({ targetPostageSats: sats });
    void this.recompute();
  }

  /**
   * Execute the transfer: build the real PSBT with the previewed funding + fee
   * and sign+broadcast via the wallet's internal `signTransfer` (input 0 = cat
   * at the ordinals address; funding inputs 1..N at the payment address).
   */
  async transfer(
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Promise<string>,
  ): Promise<{ txId: string }> {
    const wallet = this.wallet;
    const cat = this.snap.catUtxo;
    const recipient = this.snap.recipientAddress;
    const feeRate = this.snap.feeRate;
    const sim = this.snap.simulation;

    if (!wallet) throw new Error('No wallet connected');
    if (!cat) throw new Error('No cat selected');
    if (!recipient) throw new Error('No recipient address');
    if (!feeRate) throw new Error('No fee rate set');
    if (!sim) {
      throw new Error(
        this.snap.fundingRecommendation.status === 'expert-required'
          ? 'Select a funding UTXO (the available coins carry assets)'
          : 'Insufficient funds for transfer at the current fee rate',
      );
    }

    this.patch({ state: 'transferring', errorMessage: null, successTxId: null });
    try {
      const built = buildTransfer(
        this.paramsFor(wallet, cat, recipient, feeRate),
        sim.fundingUtxo,
        sim.feeSats,
        false,
      );
      const signer = findSignerOrThrow(wallet.type);
      const { txId } = await firstValueFrom(
        signer.signTransfer({
          psbtBytes: built.psbt,
          ordinalsAddress: wallet.ordinalsAddress,
          paymentAddress: wallet.paymentAddress,
          fundingInputCount: 1,
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

  reset(): void {
    this.patch({
      catUtxo: null, recipientAddress: null, feeRate: null, selectedFundingUtxo: null,
      targetPostageSats: null, simulation: null, errorMessage: null, successTxId: null,
      state: this.wallet ? 'ready' : 'idle',
    });
  }

  // --- internals ----------------------------------------------------------

  private async recompute(): Promise<void> {
    const seq = ++this.recomputeSeq;
    const wallet = this.wallet;
    const feeRate = this.snap.feeRate;
    const cat = this.snap.catUtxo;
    const recipient = this.snap.recipientAddress;
    if (!wallet || !feeRate || !cat || !recipient || this.utxos.length === 0) {
      this.patch({ simulation: null, fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    let sim: TransferSimulationResult;
    try {
      sim = await simulateTransfer(
        this.paramsFor(wallet, cat, recipient, feeRate),
        { utxos: this.utxosPort(), scan: this.deps.scan },
      );
    } catch {
      if (seq !== this.recomputeSeq) return;
      this.patch({ simulation: null, fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    if (seq !== this.recomputeSeq) return; // a newer input superseded this run
    this.patch({
      fundingRecommendation: liftRecommendationByOutpoint(sim.recommendation, this.utxos),
      simulation:
        sim.status === 'ready' && sim.fundingUtxo && sim.feeSats != null
          ? { feeSats: sim.feeSats, changeSats: sim.changeSats ?? 0, fundingUtxo: sim.fundingUtxo, catOutputSats: sim.catOutputSats ?? this.snap.catUtxo!.value }
          : null,
    });
  }

  private paramsFor(
    wallet: TransferWalletContext,
    cat: Cat21Holding,
    recipient: string,
    feeRate: number,
  ): TransferCoreParams {
    return {
      walletType: wallet.type,
      network: this.deps.network,
      ordinalsPublicKey: hex.decode(wallet.ordinalsPublicKey),
      ordinalsAddress: wallet.ordinalsAddress,
      paymentPublicKey: hex.decode(wallet.paymentPublicKey),
      paymentAddress: wallet.paymentAddress,
      catUtxo: { txid: cat.txid, vout: cat.vout, value: cat.value },
      recipientAddress: recipient,
      feeRatePerVbyte: feeRate,
      selectedFundingUtxo: this.snap.selectedFundingUtxo ? toCore(this.snap.selectedFundingUtxo) : undefined,
      targetPostageSats: this.snap.targetPostageSats ?? undefined,
    };
  }

  private utxosPort() {
    const utxos = this.utxos;
    return {
      spendableUtxos: async (): Promise<CoreFundingUtxo[]> => utxos.map(toCore),
    };
  }

  private patch(next: Partial<TransferSnapshot>): void {
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
