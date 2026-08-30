import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import { ContentScanPort } from '../cat21-core/ports';
import { selectFunding } from '../cat21-core/select-funding';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { AnnotatedFundingUtxo, FundingRecommendation } from '../cat21-fee/funding-safety';
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
 * is a thin veneer over this; both share one implementation.
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

/** ~200 vB fee ceiling the funding target must clear (the two-pass sim tightens it). */
const MINT_FEE_VBYTE_CEILING = 200;

export class Cat21MintOrchestrator {
  private wallet: MintWalletContext | null = null;
  private utxos: TxnOutput[] = [];
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
    let transactionFee: bigint;
    try {
      const { finalFeeSats } = twoPassFeeSimulation({
        simulate: (feeSats) =>
          simulateMintTransaction(
            wallet.type,
            wallet.ordinalsAddress,
            selected,
            wallet.paymentAddress,
            paymentPublicKey,
            BigInt(feeSats),
            this.deps.network,
          ),
        feeRatePerVbyte: feeRate,
        placeholderFeeSats: Math.ceil(feeRate * MINT_FEE_VBYTE_CEILING),
      });
      transactionFee = BigInt(finalFeeSats);
    } catch (err) {
      this.patch({ state: 'error', errorMessage: errMsg(err) });
      throw err;
    }

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
      errorMessage: null,
      successTxId: null,
      state: this.wallet ? 'ready' : 'idle',
    });
  }

  // --- internals ----------------------------------------------------------

  private async recompute(): Promise<void> {
    const wallet = this.wallet;
    const feeRate = this.snap.feeRate;
    if (!wallet || !feeRate || this.utxos.length === 0) {
      this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    const simulations = this.utxos.map<UtxoSimulationRow>((utxo) => {
      try {
        const { finalSimulation, finalFeeSats } = twoPassFeeSimulation({
          simulate: (feeSats) =>
            simulateMintTransaction(
              wallet.type,
              wallet.ordinalsAddress,
              utxo,
              wallet.paymentAddress,
              paymentPublicKey,
              BigInt(feeSats),
              this.deps.network,
            ),
          feeRatePerVbyte: feeRate,
          placeholderFeeSats: Math.ceil(feeRate * MINT_FEE_VBYTE_CEILING),
        });
        return {
          utxo,
          simulation: { ...finalSimulation, finalTransactionFee: BigInt(finalFeeSats) },
          insufficient: false,
        };
      } catch {
        return { utxo, simulation: null, insufficient: true };
      }
    });

    // Funding covers the fresh cat's postage (546) + the miner fee ceiling.
    const target = CAT21_POSTAGE_SATS + Math.ceil(feeRate * MINT_FEE_VBYTE_CEILING);
    let fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
    try {
      fundingRecommendation = await selectFunding<TxnOutput>(this.utxos, target, this.deps.scan);
    } catch {
      fundingRecommendation = EMPTY_RECOMMENDATION;
    }
    this.patch({ simulations, fundingRecommendation });
  }

  private patch(next: Partial<MintSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of this.listeners) l(this.snap);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
