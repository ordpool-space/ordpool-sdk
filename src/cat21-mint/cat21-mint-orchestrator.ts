import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import { ContentScanPort, CoreFundingUtxo } from '../cat21-core/ports.js';
import { MintCoreParams, simulateMint, MintStatus } from '../cat21-core/mint.core.js';
import { resolveCatTxFee } from '../cat21-fee/resolve-cat-tx-fee.helper.js';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  liftRecommendationByOutpoint,
  FundingTopologySetting,
  resolveFundingTopology,
} from '../cat21-fee/funding-safety.js';
import { CandidateFeeRow, outpointKey } from '../cat21-fee/candidate-fees.js';
import { sameWallet } from '../wallet/wallet-identity.js';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage.js';
import { Network } from '../network.js';
import { findSignerOrThrow } from '../wallet/signers/index.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { createTransaction, simulateMintTransaction } from './cat21.service.helper.js';
import { SimulateTransactionResult, TxnOutput } from './cat21.service.types.js';
import { dedupeUtxosByOutpoint } from '../cat21-core/dedupe-utxos.js';

/**
 * High-level mint API. Plain class, no signals. The SDK owns this
 * orchestration; a consumer IMPORTS it ready-made and binds its
 * `subscribe(listener)` callback to whatever reactivity it uses in ONE line
 * (`orch.subscribe(s => sig.set(s))`). The orchestrator wires wallet-backed
 * signing internally (the signer registry) and the fee/selection/build logic
 * (the shared helpers + the force-scanning `selectFunding`); the consumer
 * supplies only the I/O it owns (electrs/ord/broadcast) as the
 * `MintOrchestratorDeps` callbacks and the connected wallet via `setWallet`.
 */

/** State machine the UI branches on. */
export type MintOrchestratorState =
  | 'idle' | 'loading-utxos' | 'ready' | 'minting' | 'success' | 'error';

/** One row in the per-UTXO simulation grid (the expert picker). */
/**
 * What a picker row shows about one coin.
 *
 * The built `Transaction` is deliberately absent. Nothing reads it — not this
 * package, not any consumer — and retaining one per coin means a full
 * Transaction object for every UTXO in the wallet, rebuilt on every recompute.
 */
export interface UtxoSimulationView {
  vsize: number;
  /** Realised miner fee, sub-dust absorb included. */
  finalTransactionFee: bigint;
  /** The cat output a mint creates. */
  amountToRecipient: bigint;
  singleInputAmount: bigint;
  changeAmount: bigint;
}

export interface UtxoSimulationRow {
  utxo: TxnOutput;
  simulation: UtxoSimulationView | null;
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
  /**
   * What each candidate coin would cost as the funding input, on the same
   * outpoint key the recommendation uses (`outpointKey`). This is the core's
   * number, not the orchestrator's grid: a picker binds to it so every surface
   * shows one figure, and `absorbedSubDustSats` tells a coin that over-pays
   * apart from one that cannot pay at all.
   */
  candidateFees: CandidateFeeRow[];
  /**
   * The two targets selection uses. A coin below `fundingRequirementSats`
   * cannot fund the mint; selection PREFERS one clearing
   * `fundingPreferredSats`, the change-headroom target. Both are 0 before a
   * measurable plan exists, which says "unknown" rather than implying a floor.
   */
  fundingRequirementSats: number;
  fundingPreferredSats: number;
  /**
   * The coin the mint WOULD actually spend, after the explicit pick has been
   * applied, and the verdict that goes with it. `fundingRecommendation` answers
   * "what would we choose"; these answer "what happens if you press the
   * button", which is the question a CTA is gated on.
   *
   * Without them a consumer has to re-derive the verdict from
   * `selectedUtxo` plus the recommendation, and a consumer computing its own
   * funding policy is what the asset-safety rule forbids: the next asset class
   * added to the scanner would never reach it.
   */
  resolvedFundingUtxo: CoreFundingUtxo | null;
  resolvedFundingStatus: MintStatus | null;
  errorMessage: string | null;
  successTxId: string | null;
}

const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'insufficient',
  recommended: null,
  candidates: [],
};

/**
 * Whether two funding selections name the same coin.
 *
 * `setSelectedUtxo` recomputes, so re-applying the SAME selection would patch
 * and recompute for an answer that cannot differ. A consumer that re-drives
 * the setter from a stream the recompute itself feeds then loops without
 * bound: patch, emit, set, recompute, emit. Comparing the outpoint makes the
 * no-change call free and the loop impossible.
 *
 * The object identity is deliberately NOT part of this. A refreshed candidate
 * for the same outpoint carries newer annotations, and the live one is
 * `resolvedFundingUtxo`, which consumers render from.
 */
function sameSelection(a: { txid: string; vout: number } | null, b: { txid: string; vout: number } | null): boolean {
  if (a === null || b === null) return a === b;
  return a.txid === b.txid && a.vout === b.vout;
}

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
    candidateFees: [],
    fundingRequirementSats: 0,
    fundingPreferredSats: 0,
    resolvedFundingUtxo: null,
    resolvedFundingStatus: null,
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
  /**
   * Refetch the funding UTXOs for the connected wallet and recompute.
   *
   * The set is otherwise read ONCE, when the wallet connects. So a page that
   * connected while the funding transaction was still unconfirmed, or before
   * electrs had indexed it, holds an empty or stale set for as long as it
   * stays open: the CTA sits disabled, and no fee-rate change fixes it,
   * because the fee rate is not what is missing. Only a reload was.
   *
   * Deliberately NOT polled here. How often to re-read, and on what event, is
   * the consumer's call: a page that knows it just funded an address can ask
   * immediately, and one that does not should not be made to poll electrs on a
   * timer by a decision taken in this layer.
   *
   * Leaves the fee rate and any expert-mode selection alone, since neither is
   * invalidated by new coins arriving.
   */
  /** Re-read the UTXO set for the CURRENT wallet, without resetting the form. */
  async refreshUtxos(): Promise<void> {
    if (!this.wallet) return;
    await this.loadUtxos(this.wallet);
  }

  /**
   * Connect, switch or disconnect the wallet.
   *
   * A RE-EMISSION OF THE SAME WALLET IS A NO-OP. `WalletService`'s subject
   * pushes the same wallet again on every `onAccountChange`, and Xverse and
   * cat21-wallet fire that repeatedly, so a consumer binding that stream
   * straight to this method would otherwise re-run the whole load for a wallet
   * that did not change. That drops the orchestrator back through
   * `loading-utxos`, which tears any control gated on that state out of the DOM
   * for a frame; a click landing in that frame is lost, and the symptom is an
   * approval popup that never appears.
   *
   * Identity is the FULL tuple, not one address: comparing a single field
   * treats a real wallet change as a re-emission and keeps state belonging to
   * the previous wallet.
   *
   * To re-read the UTXO set for the wallet already connected, call
   * `refreshUtxos()`. This method deliberately no longer doubles as that.
   */
  async setWallet(wallet: MintWalletContext | null): Promise<void> {
    if (sameWallet(this.wallet, wallet)) return;
    this.wallet = wallet;
    this.recomputeSeq++; // invalidate any in-flight recompute from the old wallet
    this.patch({ feeRate: null, selectedUtxo: null, errorMessage: null, successTxId: null });
    if (!wallet) {
      this.utxos = [];
      this.patch({ state: 'idle', simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION, candidateFees: [], fundingRequirementSats: 0, fundingPreferredSats: 0 });
      return;
    }
    await this.loadUtxos(wallet);
  }

  private async loadUtxos(wallet: MintWalletContext): Promise<void> {
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

  /**
   * Take an explicit funding pick, then RE-DECIDE.
   *
   * The pick feeds `selectedFundingUtxo` in the core, so the recommendation is
   * a different answer once it is set. Patching without recomputing leaves
   * `fundingRecommendation.status` describing the AUTO pick, which forces a
   * consumer to override the verdict locally in order to enable its CTA, and a
   * consumer that computes its own funding policy is exactly what the
   * asset-safety rule forbids: the next asset class added to the scanner would
   * never reach it.
   */
  setSelectedUtxo(utxo: TxnOutput | null): void {
    if (sameSelection(this.snap.selectedUtxo, utxo)) return;
    this.patch({ selectedUtxo: utxo });
    void this.recompute();
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
      candidateFees: [],
      fundingRequirementSats: 0,
      fundingPreferredSats: 0,
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
      this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION, candidateFees: [], fundingRequirementSats: 0, fundingPreferredSats: 0 });
      return;
    }
    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    // Safe-auto recommendation: delegate to mint.core's `simulateMint` (the
    // guess-free target + content-scan selection, single source of truth), then
    // lift its CoreFundingUtxo picks back into the TxnOutput domain by outpoint.
    let fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = EMPTY_RECOMMENDATION;
    let candidateFees: CandidateFeeRow[] = [];
    let recomputeError: string | null = null;
    let fundingRequirementSats = 0;
    let fundingPreferredSats = 0;
    let resolvedFundingUtxo: CoreFundingUtxo | null = null;
    let resolvedFundingStatus: MintStatus | null = null;
    try {
      const mintSim = await simulateMint(this.mintParams(wallet, paymentPublicKey, feeRate), {
        utxos: this.utxosPort(),
        scan: this.deps.scan,
      });
      fundingRecommendation = liftRecommendationByOutpoint(mintSim.recommendation, this.utxos);
      candidateFees = mintSim.candidateFees;
      fundingRequirementSats = mintSim.fundingRequirementSats;
      fundingPreferredSats = mintSim.fundingPreferredSats;
      resolvedFundingUtxo = mintSim.fundingUtxo;
      resolvedFundingStatus = mintSim.status;
    } catch (err) {
      fundingRecommendation = EMPTY_RECOMMENDATION;
      // Keep the REASON. An empty recommendation renders as a disabled control,
      // so discarding the error here produces a screen that refuses and cannot
      // say why, which is indistinguishable from an empty wallet and takes a CI
      // bisect to tell apart.
      recomputeError = `Could not price the funding coins: ${errMsg(err)}`;
    }
    if (seq !== this.recomputeSeq) return; // a newer input superseded this run
    this.patch({
      // A failed recompute yields NO rows rather than rows claiming every coin
      // cannot fund the mint. That claim would be false: the reason is in
      // `errorMessage`, not the fee rate, and a picker rendering "can't fund at
      // this rate" against a whole wallet states something nobody measured.
      simulations: recomputeError ? [] : this.rowsFrom(candidateFees),
      fundingRecommendation, candidateFees,
      fundingRequirementSats, fundingPreferredSats,
      resolvedFundingUtxo, resolvedFundingStatus,
      // Keeping the reason is not enough on its own: every consumer gates its
      // banner on `state === 'error'`, so a message written while the state
      // stays `ready` is unreachable and the screen falls through to "not
      // enough Bitcoin, add funds" for what is a code or network fault.
      ...(recomputeError
        ? { errorMessage: recomputeError, state: 'error' as const }
        // And a SUCCESSFUL recompute must not clear a message it did not
        // write. `mint()`'s broadcast failure and `loadUtxos`'s failure both
        // land on this field, and clobbering one leaves `state: 'error'` with
        // nothing to render: a dead end with no text and no CTA.
        : this.snap.state === 'error' ? {} : { errorMessage: null }),
    });
  }

  /**
   * Guess-free realised fee for one funding coin, or null when it can't mint at
   * the fee rate. Measures the with-change form and falls back to no-change /
   * absorb, so a coin that genuinely fits is never rejected.
   */
  /**
   * The picker's per-coin grid, DERIVED from the core's per-candidate fees
   * rather than priced a second time.
   *
   * Every field follows from the fee the core already measured. The cat output
   * is the mint's fixed postage; change is what is left after postage and the
   * realised fee, which lands at exactly 0 for a coin whose leftover was folded
   * in, because that fee already absorbed it. So there is nothing here a second
   * round of PSBT builds could learn.
   *
   * Pricing every coin twice cost ~1.8 ms per coin per pass, and the two passes
   * disagreed about the tip: this one never subtracted it while the core always
   * did, so the day a tip was wired through, every row would have shown a fee
   * and a change the mint would not produce. One source cannot drift from
   * itself.
   */
  private rowsFrom(candidateFees: CandidateFeeRow[]): UtxoSimulationRow[] {
    const feeByOutpoint = new Map(candidateFees.map((f) => [outpointKey(f), f] as const));
    return this.utxos.map<UtxoSimulationRow>((utxo) => {
      const fee = feeByOutpoint.get(outpointKey(utxo));
      if (!fee || fee.finalFeeSats === null || fee.vsize === null) {
        return { utxo, simulation: null, insufficient: true };
      }
      return {
        utxo,
        simulation: {
          vsize: fee.vsize,
          finalTransactionFee: BigInt(fee.finalFeeSats),
          amountToRecipient: BigInt(CAT21_POSTAGE_SATS),
          singleInputAmount: BigInt(utxo.value),
          changeAmount: BigInt(utxo.value - CAT21_POSTAGE_SATS - fee.finalFeeSats),
        },
        insufficient: false,
      };
    });
  }

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
      fundingTopology: resolveFundingTopology(this.deps.fundingTopology, wallet),
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
