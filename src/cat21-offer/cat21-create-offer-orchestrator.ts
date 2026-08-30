import { firstValueFrom, from } from 'rxjs';
import { base64, hex } from '@scure/base';

import { buildOffer, CreateOfferCoreParams, simulateCreateOffer } from '../cat21-core/create-offer.core';
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
import { BuyOfferTargetCat } from './cat21-offer.types';

/**
 * FRAMEWORK-AGNOSTIC high-level create-offer (buyer bid) API. Plain class — no
 * Angular. Owns the bid state machine + safe-auto funding pick (via
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
  bid: OfferBidArtifact | null;
  errorMessage: string | null;
}

const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'insufficient',
  recommended: null,
  candidates: [],
};

export class Cat21CreateOfferOrchestrator {
  private wallet: CreateOfferWalletContext | null = null;
  private utxos: TxnOutput[] = [];
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

  async setWallet(wallet: CreateOfferWalletContext | null): Promise<void> {
    const changed = (this.wallet?.paymentAddress ?? null) !== (wallet?.paymentAddress ?? null);
    this.wallet = wallet;
    this.recomputeSeq++; // invalidate any in-flight recompute from the old wallet
    if (changed) {
      this.patch({
        targetCat: null, priceSats: null, sellerPaymentAddress: null, buyerReceiveAddress: wallet?.ordinalsAddress ?? null,
        feeRate: null, selectedFundingUtxo: null, bid: null, errorMessage: null,
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
  setSelectedFundingUtxo(utxo: TxnOutput | null): void { this.patch({ selectedFundingUtxo: utxo }); void this.recompute(); }

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
      this.patch({ simulation: null, fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    try {
      const sim = await simulateCreateOffer(params, { utxos: this.utxosPort(), scan: this.deps.scan });
      if (seq !== this.recomputeSeq) return; // a newer input superseded this run
      this.patch({
        fundingRecommendation: liftRecommendationByOutpoint(sim.recommendation, this.utxos),
        simulation:
          sim.status === 'ready' && sim.buyerFundingUtxo && sim.feeSats != null
            ? { feeSats: sim.feeSats, changeSats: sim.changeSats ?? 0, buyerFundingUtxo: sim.buyerFundingUtxo }
            : null,
      });
    } catch {
      if (seq !== this.recomputeSeq) return;
      this.patch({ simulation: null, fundingRecommendation: EMPTY_RECOMMENDATION });
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
