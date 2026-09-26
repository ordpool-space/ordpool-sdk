import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import {
  buildTransfer,
  simulateTransfer,
  TransferCoreParams,
  TransferSimulationResult,
} from '../cat21-core/transfer.core.js';
import { ContentScanPort, CoreFundingUtxo } from '../cat21-core/ports.js';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  liftRecommendationByOutpoint,
  FundingTopologySetting,
  resolveFundingTopology,
} from '../cat21-fee/funding-safety.js';
import { sameWallet } from '../wallet/wallet-identity.js';
import { CandidateFeeRow } from '../cat21-fee/candidate-fees.js';
import { Network } from '../network.js';
import { findSignerOrThrow } from '../wallet/signers/index.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { TxnOutput } from '../cat21-mint/cat21.service.types.js';
import { Cat21Holding } from './cat21-transfer.types.js';
import { dedupeUtxosByOutpoint } from '../cat21-core/dedupe-utxos.js';

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
  /**
   * How this consumer's wallet lays out its addresses, deciding whether a
   * dirty-only funding pool produces a NOTICE (separate payment address) or a
   * blocking WARNING (one address for everything).
   *
   * Pass `'derive'` and it is worked out from the connected wallet. UI and
   * agent callers both do; they get the same answer, because the decision is
   * the same decision. Omitting it keeps the blocking answer, which protects a
   * caller who forgot rather than expressing anything about agents.
   */
  fundingTopology?: FundingTopologySetting;
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
  /**
   * What each candidate coin would cost as the funding input, on the same
   * outpoint key the recommendation uses (`outpointKey`). A picker binds to it
   * so every surface shows one figure, and `absorbedSubDustSats` tells a coin
   * that over-pays apart from one that cannot pay at all.
   */
  candidateFees: CandidateFeeRow[];
  /**
   * The two targets selection uses. A coin below `fundingRequirementSats`
   * cannot fund the action; selection PREFERS one clearing
   * `fundingPreferredSats`, the change-headroom target. Both are 0 before a
   * measurable plan exists, which says "unknown" rather than implying a floor.
   */
  fundingRequirementSats: number;
  fundingPreferredSats: number;
  errorMessage: string | null;
  successTxId: string | null;
}

/** No answer yet. `scanning`, never `insufficient`: that is a measured verdict. */
const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'scanning',
  recommended: null,
  candidates: [],
};

/** The funding set was READ and holds nothing that can cover the action. */
const INSUFFICIENT_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'insufficient',
  recommended: null,
  candidates: [],
};

/**
 * Same coin? `setSelectedFundingUtxo` recomputes, so re-applying an unchanged
 * selection would loop a consumer that re-drives it from the snapshot.
 * Outpoint only: a refreshed row for the same coin is not a change.
 */
function sameSelection(a: { txid: string; vout: number } | null, b: { txid: string; vout: number } | null): boolean {
  if (a === null || b === null) return a === b;
  return a.txid === b.txid && a.vout === b.vout;
}

export class Cat21TransferOrchestrator {
  private wallet: TransferWalletContext | null = null;
  private utxos: TxnOutput[] = [];
  /** True once `utxos` holds a completed read. An unread set is also `[]`, and only a read one can be called empty. */
  private utxosRead = false;
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
    candidateFees: [],
    fundingRequirementSats: 0,
    fundingPreferredSats: 0,
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

  /**
   * Refetch the funding UTXOs for the connected wallet and recompute.
   *
   * The set is otherwise read ONCE, when the wallet connects, so a page that
   * connected while its funding transaction was still unconfirmed, or before
   * electrs had indexed it, stays stuck: the CTA sits disabled and no fee-rate
   * change fixes it, because the fee rate is not what is missing.
   *
   * Deliberately NOT polled here. How often to re-read, and on what event, is
   * the consumer's call. Leaves the fee rate and any expert-mode selection
   * alone, since neither is invalidated by new coins arriving.
   */
  /** Re-read the UTXO set for the CURRENT wallet, without resetting the form. */
  async refreshUtxos(): Promise<void> {
    if (!this.wallet) return;
    await this.loadUtxos(this.wallet);
  }

  async setWallet(wallet: TransferWalletContext | null): Promise<void> {
    // A RE-EMISSION OF THE SAME WALLET IS A NO-OP: WalletService's subject
    // pushes the same wallet again on every onAccountChange, and re-running the
    // load drops this back through `loading-utxos`, which tears any control
    // gated on that state out of the DOM for a frame. A click landing there is
    // lost. Identity is the FULL tuple: one address treats a real change as a
    // re-emission. To re-read for the connected wallet, call `refreshUtxos()`.
    if (sameWallet(this.wallet, wallet)) return;
    this.wallet = wallet;
    this.recomputeSeq++; // invalidate any in-flight recompute from the old wallet
    {
      this.patch({
        catUtxo: null, recipientAddress: null, selectedFundingUtxo: null,
        targetPostageSats: null, errorMessage: null, successTxId: null,
      });
    }
    if (!wallet) {
      this.utxos = [];
      this.utxosRead = false;
      this.patch({ state: 'idle', simulation: null, fundingRecommendation: EMPTY_RECOMMENDATION, candidateFees: [], fundingRequirementSats: 0, fundingPreferredSats: 0 });
      return;
    }
    await this.loadUtxos(wallet);
  }

  private async loadUtxos(wallet: TransferWalletContext): Promise<void> {
    // Invalidate any in-flight recompute BEFORE the first await, not only
    // via the one at the end: the catch below returns early, so on a failed
    // load a recompute started by an earlier input would still hold a valid
    // seq, land afterwards, and patch stale rows over an emptied utxo set.
    this.recomputeSeq++;
    this.patch({ state: 'loading-utxos' });
    try {
      // Deduped here, not only in the SDK's own electrs readers: `getUtxos` is a
      // CONSUMER-supplied port, and electrs can list the same outpoint twice around
      // the moment a tx confirms. A consumer wiring its own fetch would otherwise
      // double-count a funding row and show a doubled balance.
      this.utxos = dedupeUtxosByOutpoint(await this.deps.getUtxos(wallet.paymentAddress));
      this.utxosRead = true;
      this.patch({ state: 'ready' });
    } catch (err) {
      this.utxos = [];
      this.utxosRead = false;
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
    if (sameSelection(this.snap.selectedFundingUtxo, utxo)) return;
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
      // Read-and-empty is a verdict; a missing input is no verdict.
      const measuredEmpty = this.utxosRead && this.utxos.length === 0;
      this.patch({ simulation: null, fundingRecommendation: measuredEmpty ? INSUFFICIENT_RECOMMENDATION : EMPTY_RECOMMENDATION, candidateFees: [], fundingRequirementSats: 0, fundingPreferredSats: 0 });
      return;
    }
    let sim: TransferSimulationResult;
    try {
      sim = await simulateTransfer(
        this.paramsFor(wallet, cat, recipient, feeRate),
        { utxos: this.utxosPort(), scan: this.deps.scan },
      );
    } catch (err) {
      if (seq !== this.recomputeSeq) return;
      // Keep the REASON and make it REACHABLE. An empty recommendation renders
      // as a disabled control and the page then says "not enough Bitcoin, add
      // funds" for what is a code or network fault, so the user tops up an
      // address that was never the problem. Consumers gate their banner on
      // `state === 'error'`, so the message has to travel with the state.
      this.patch({ simulation: null,
        fundingRecommendation: EMPTY_RECOMMENDATION, candidateFees: [],
        fundingRequirementSats: 0, fundingPreferredSats: 0,
        errorMessage: `Could not price the funding coins: ${errMsg(err)}`,
        state: 'error',
      });
      return;
    }
    if (seq !== this.recomputeSeq) return; // a newer input superseded this run
    this.patch({
      fundingRecommendation: liftRecommendationByOutpoint(sim.recommendation, this.utxos),
      candidateFees: sim.candidateFees,
      fundingRequirementSats: sim.fundingRequirementSats,
      fundingPreferredSats: sim.fundingPreferredSats,
      // `asset-notice` is a PROCEED state: the plan is built and the coin is
      // chosen, the caller's obligation is to name what sits on it. Withholding
      // the summary here would leave a consumer with a buildable transaction it
      // cannot render, which reads on screen as a disabled control with nothing
      // explaining it. `ready` and `asset-notice` both carry a plan; only
      // `expert-required` and `insufficient` do not.
      simulation:
        (sim.status === 'ready' || sim.status === 'asset-notice') && sim.fundingUtxo && sim.feeSats != null
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
      fundingTopology: resolveFundingTopology(this.deps.fundingTopology, wallet),
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
