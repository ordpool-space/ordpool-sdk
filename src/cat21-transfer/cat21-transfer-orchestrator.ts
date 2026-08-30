import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import { buildTransfer } from '../cat21-core/transfer.core';
import { ContentScanPort, CoreFundingUtxo } from '../cat21-core/ports';
import { selectFunding } from '../cat21-core/select-funding';
import { getMinimumUtxoSize } from '../cat21-script/address-format';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper';
import { AnnotatedFundingUtxo, FundingRecommendation } from '../cat21-fee/funding-safety';
import { Network, toScureNetwork } from '../network';
import { findSignerOrThrow } from '../wallet/signers';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS } from './cat21-transfer.helper';
import { Cat21Holding } from './cat21-transfer.types';

/**
 * FRAMEWORK-AGNOSTIC high-level transfer API. Plain class — no Angular. Owns
 * the transfer state machine + safe-auto funding pick (via `selectFunding`'s
 * force-scan), reuses `transfer.core`'s `buildTransfer` (no duplication), and
 * wires wallet-backed sign+broadcast INTERNALLY via `findSignerOrThrow`
 * (`signer.signTransfer`). State ships through a plain `subscribe(listener)`
 * callback; a consumer imports it ready-made and binds in one line.
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
  fundingUtxo: TxnOutput;
}

export interface TransferSnapshot {
  state: TransferOrchestratorState;
  catUtxo: Cat21Holding | null;
  recipientAddress: string | null;
  feeRate: number | null;
  selectedFundingUtxo: TxnOutput | null;
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

/** ~200 vB fee ceiling (cat preserved, so funding covers ONLY the fee). */
const TRANSFER_FEE_VBYTE_CEILING = 200;

export class Cat21TransferOrchestrator {
  private wallet: TransferWalletContext | null = null;
  private utxos: TxnOutput[] = [];
  private snap: TransferSnapshot = {
    state: 'idle',
    catUtxo: null,
    recipientAddress: null,
    feeRate: null,
    selectedFundingUtxo: null,
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
    if (changed) {
      this.patch({
        catUtxo: null, recipientAddress: null, feeRate: null, selectedFundingUtxo: null,
        errorMessage: null, successTxId: null,
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
        toCore(sim.fundingUtxo),
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
      simulation: null, errorMessage: null, successTxId: null,
      state: this.wallet ? 'ready' : 'idle',
    });
  }

  // --- internals ----------------------------------------------------------

  private async recompute(): Promise<void> {
    const wallet = this.wallet;
    const feeRate = this.snap.feeRate;
    if (!wallet || !feeRate || this.utxos.length === 0) {
      this.patch({ simulation: null, fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    // Cat preserved: funding covers ONLY the miner fee.
    const feeTarget = Math.ceil(feeRate * TRANSFER_FEE_VBYTE_CEILING);
    let recommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
    try {
      recommendation = await selectFunding<TxnOutput>(this.utxos, feeTarget, this.deps.scan);
    } catch {
      recommendation = EMPTY_RECOMMENDATION;
    }

    const pick = this.pickFunding(recommendation, feeTarget);
    let simulation: TransferSimulationView | null = null;
    const cat = this.snap.catUtxo;
    const recipient = this.snap.recipientAddress;
    if (cat && recipient && pick) {
      try {
        const params = this.paramsFor(wallet, cat, recipient, feeRate);
        const fundingCore = toCore(pick);
        const two = twoPassFeeSimulation({
          simulate: (feeSats) => {
            const built = buildTransfer(params, fundingCore, feeSats, true);
            return { built, vsize: computePsbtVsize({ psbt: built.psbt, network: toScureNetwork(this.deps.network) }) };
          },
          feeRatePerVbyte: feeRate,
          placeholderFeeSats: feeTarget,
        });
        const changeRaw = pick.value - two.finalFeeSats;
        let dustLimit: number;
        try {
          dustLimit = getMinimumUtxoSize(wallet.paymentAddress);
        } catch {
          dustLimit = CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS;
        }
        simulation = {
          feeSats: two.finalFeeSats,
          changeSats: changeRaw >= dustLimit ? changeRaw : 0,
          fundingUtxo: pick,
        };
      } catch {
        simulation = null;
      }
    }
    this.patch({ fundingRecommendation: recommendation, simulation });
  }

  /** Expert override wins if it still covers; else the safe auto-clean coin. */
  private pickFunding(
    rec: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>,
    feeTarget: number,
  ): TxnOutput | null {
    const selected = this.snap.selectedFundingUtxo;
    const stillPresent = selected
      ? rec.candidates.find((u) => u.txid === selected.txid && u.vout === selected.vout)
      : undefined;
    if (stillPresent && stillPresent.value >= feeTarget) return stillPresent;
    return rec.status === 'auto' ? rec.recommended : null;
  }

  private paramsFor(wallet: TransferWalletContext, cat: Cat21Holding, recipient: string, feeRate: number) {
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
