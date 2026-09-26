import { firstValueFrom, from } from 'rxjs';
import { base64, hex } from '@scure/base';

import { buildOffer, CreateOfferCoreParams, simulateCreateOffer } from '../cat21-core/create-offer.core.js';
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
import { BuyOfferTargetCat } from './cat21-offer.types.js';
import { dedupeUtxosByOutpoint } from '../cat21-core/dedupe-utxos.js';

/**
 * FRAMEWORK-AGNOSTIC high-level create-offer (buyer bid) API. Plain class.
 * Owns the bid state machine + safe-auto funding pick (via
 * `selectFunding`'s force-scan inside `simulateCreateOffer`), reuses
 * `create-offer.core`'s `buildOffer` (no duplication), and buyer-signs via the
 * internal `signer.signOfferCreatePsbt`. This flow produces a bid ARTIFACT
 * (a buyer-signed PSBT the seller later accepts) — it does NOT broadcast.
 * State ships through a plain `subscribe(listener)` callback.
 */

export type CreateOfferOrchestratorState =
  | 'idle' | 'loading-utxos' | 'ready' | 'creating' | 'success' | 'error';

export interface CreateOfferWalletContext {
  type: KnownOrdinalWalletType;
  /** Buyer's ordinals address — where the cat lands (default receive address). */
  ordinalsAddress: string;
  paymentAddress: string;
  /** hex-encoded payment public key (funds the offer + signs the buyer inputs). */
  paymentPublicKey: string;
}

export interface CreateOfferOrchestratorDeps {
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
  network: Network;
}

export interface CreateOfferSimulationView {
  feeSats: number;
  changeSats: number;
  buyerFundingUtxo: CoreFundingUtxo;
}

/** The buyer-signed bid — bare base64/hex to share anywhere (offers are public). */
export interface OfferBidArtifact {
  base64: string;
  hex: string;
}

export interface CreateOfferSnapshot {
  state: CreateOfferOrchestratorState;
  targetCat: BuyOfferTargetCat | null;
  priceSats: number | null;
  sellerPaymentAddress: string | null;
  buyerReceiveAddress: string | null;
  feeRate: number | null;
  selectedFundingUtxo: TxnOutput | null;
  // Candidates are lifted to the consumer's TxnOutput domain (carrying `status`,
  // `transactionHex`, …) so a picker UI renders them directly.
  fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
  simulation: CreateOfferSimulationView | null;
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
  bid: OfferBidArtifact | null;
  errorMessage: string | null;
}

/** No answer yet. `scanning`, never `insufficient`: that is a measured verdict. */
const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'scanning',
  recommended: null,
  candidates: [],
};

/** The funding set was READ and holds nothing. */
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

export class Cat21CreateOfferOrchestrator {
  private wallet: CreateOfferWalletContext | null = null;
  private utxos: TxnOutput[] = [];
  /** True once `utxos` holds a completed read. An unread set is also `[]`, and only a read one can be called empty. */
  private utxosRead = false;
  // Monotonic guard: a setter/wallet-change bumps this; an in-flight async
  // recompute whose captured seq is stale drops its result instead of
  // overwriting a newer snapshot (the plain-class replacement for switchMap).
  private recomputeSeq = 0;
  private snap: CreateOfferSnapshot = {
    state: 'idle',
    targetCat: null,
    priceSats: null,
    sellerPaymentAddress: null,
    buyerReceiveAddress: null,
    feeRate: null,
    selectedFundingUtxo: null,
    fundingRecommendation: EMPTY_RECOMMENDATION,
    simulation: null,
    candidateFees: [],
    fundingRequirementSats: 0,
    fundingPreferredSats: 0,
    bid: null,
    errorMessage: null,
  };
  private readonly listeners = new Set<(s: CreateOfferSnapshot) => void>();

  constructor(private readonly deps: CreateOfferOrchestratorDeps) {}

  getSnapshot(): CreateOfferSnapshot {
    return this.snap;
  }

  subscribe(listener: (s: CreateOfferSnapshot) => void): () => void {
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

  async setWallet(wallet: CreateOfferWalletContext | null): Promise<void> {
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
        targetCat: null, priceSats: null, sellerPaymentAddress: null, buyerReceiveAddress: wallet?.ordinalsAddress ?? null,
        feeRate: null, selectedFundingUtxo: null, bid: null, errorMessage: null,
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

  private async loadUtxos(wallet: CreateOfferWalletContext): Promise<void> {
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

  setTargetCat(cat: BuyOfferTargetCat | null): void { this.patch({ targetCat: cat }); void this.recompute(); }
  setPriceSats(price: number): void {
    // Floor to whole sats: a fractional price reaches BigInt(price + value) in
    // the offer builder, which throws RangeError on a non-integer.
    const p = Math.floor(price);
    if (Number.isFinite(price) && p > 0) { this.patch({ priceSats: p }); void this.recompute(); }
  }
  setSellerPaymentAddress(addr: string | null): void { this.patch({ sellerPaymentAddress: addr }); void this.recompute(); }
  setBuyerReceiveAddress(addr: string | null): void { this.patch({ buyerReceiveAddress: addr }); void this.recompute(); }
  setFeeRate(rate: number): void { if (Number.isFinite(rate) && rate > 0) { this.patch({ feeRate: rate }); void this.recompute(); } }
  setSelectedFundingUtxo(utxo: TxnOutput | null): void {
    if (sameSelection(this.snap.selectedFundingUtxo, utxo)) return;
    this.patch({ selectedFundingUtxo: utxo });
    void this.recompute();
  }

  /**
   * Build + buyer-sign the bid PSBT (the artifact). No broadcast — the seller
   * accepts + broadcasts later. `bid` on success carries the shareable base64/hex.
   */
  async createOffer(
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Promise<string>,
  ): Promise<OfferBidArtifact> {
    const params = this.params();
    const sim = this.snap.simulation;
    if (!params) throw new Error(this.missingInputError());
    if (!sim) {
      throw new Error(
        this.snap.fundingRecommendation.status === 'expert-required'
          ? 'Select a funding UTXO (the available coins carry assets)'
          : 'Insufficient funds for buy-offer at the current price + fee rate',
      );
    }

    this.patch({ state: 'creating', errorMessage: null, bid: null });
    try {
      const built = buildOffer(params, sim.buyerFundingUtxo, sim.feeSats, false);
      const signer = findSignerOrThrow(params.walletType);
      const signedPsbtBytes = await firstValueFrom(
        signer.signOfferCreatePsbt({
          psbtBytes: built.psbt,
          paymentAddress: params.paymentAddress,
          fundingInputCount: 1,
          network: this.deps.network,
          promptForSignedPsbt: promptForSignedPsbt
            ? (unsigned) => from(promptForSignedPsbt(unsigned))
            : undefined,
        }),
      );
      const bid: OfferBidArtifact = {
        base64: base64.encode(signedPsbtBytes),
        hex: hex.encode(signedPsbtBytes),
      };
      this.patch({ state: 'success', bid });
      return bid;
    } catch (err) {
      this.patch({ state: 'error', errorMessage: errMsg(err) });
      throw err;
    }
  }

  reset(): void {
    this.patch({
      targetCat: null, priceSats: null, sellerPaymentAddress: null,
      buyerReceiveAddress: this.wallet?.ordinalsAddress ?? null,
      feeRate: null, selectedFundingUtxo: null, simulation: null, bid: null, errorMessage: null,
      state: this.wallet ? 'ready' : 'idle',
    });
  }

  // --- internals ----------------------------------------------------------

  private async recompute(): Promise<void> {
    const seq = ++this.recomputeSeq;
    const params = this.params();
    if (!params) {
      // Read-and-empty is a verdict whatever inputs are still missing.
      const measuredEmpty = this.utxosRead && this.utxos.length === 0;
      this.patch({ simulation: null, fundingRecommendation: measuredEmpty ? INSUFFICIENT_RECOMMENDATION : EMPTY_RECOMMENDATION, candidateFees: [], fundingRequirementSats: 0, fundingPreferredSats: 0 });
      return;
    }
    try {
      const sim = await simulateCreateOffer(params, { utxos: this.utxosPort(), scan: this.deps.scan });
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
          (sim.status === 'ready' || sim.status === 'asset-notice') && sim.buyerFundingUtxo && sim.feeSats != null
            ? { feeSats: sim.feeSats, changeSats: sim.changeSats ?? 0, buyerFundingUtxo: sim.buyerFundingUtxo }
            : null,
      });
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
    }
  }

  /** Build the core params, or null when a required input is missing. */
  private params(): CreateOfferCoreParams | null {
    const w = this.wallet;
    const { targetCat, priceSats, sellerPaymentAddress, buyerReceiveAddress, feeRate, selectedFundingUtxo } = this.snap;
    if (!w || !targetCat || !priceSats || !sellerPaymentAddress || !buyerReceiveAddress || !feeRate) return null;
    return {
      walletType: w.type,
      network: this.deps.network,
      paymentPublicKey: hex.decode(w.paymentPublicKey),
      paymentAddress: w.paymentAddress,
      buyerReceiveAddress,
      sellerPaymentAddress,
      targetCat: { txid: targetCat.txid, vout: targetCat.vout, value: targetCat.value, scriptPubKey: targetCat.scriptPubKey },
      priceSats,
      feeRatePerVbyte: feeRate,
      selectedFundingUtxo: selectedFundingUtxo ? toCore(selectedFundingUtxo) : undefined,
      fundingTopology: resolveFundingTopology(this.deps.fundingTopology, w),
    };
  }

  private missingInputError(): string {
    if (!this.wallet) return 'No wallet connected';
    if (!this.snap.targetCat) return 'No target cat selected';
    if (!this.snap.sellerPaymentAddress) return 'No seller payment address';
    if (!this.snap.priceSats) return 'No price set';
    if (!this.snap.buyerReceiveAddress) return 'No buyer receive address';
    return 'No fee rate set';
  }

  private utxosPort() {
    const utxos = this.utxos;
    return {
      spendableUtxos: async (): Promise<CoreFundingUtxo[]> => utxos.map(toCore),
    };
  }

  private patch(next: Partial<CreateOfferSnapshot>): void {
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
