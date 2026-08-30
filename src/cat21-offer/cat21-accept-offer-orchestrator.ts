import { acceptOffer as acceptOfferCore, AcceptOfferCoreParams } from '../cat21-core/accept-offer.core';
import { BroadcastOutcome } from '../cat21-core/ports';
import { CatOutpoint } from '../cat21-share/cat-outpoint';
import { Network } from '../network';
import { PaymentAddress } from '../wallet/address-types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { validateCat21BuyOfferPsbt } from './cat21-offer.helper';
import { Cat21OfferValidation } from './cat21-offer.types';
import { decodePastedPsbt } from './decode-pasted-psbt';

/**
 * FRAMEWORK-AGNOSTIC seller-side accept-offer API. Plain class — no Angular.
 * The seller pastes a buyer-built buy-offer PSBT; the orchestrator decodes it,
 * validates against the seller's intent (right cat / price floor / payout
 * address / sniping-proof shape) via the shared `validateCat21BuyOfferPsbt`,
 * then on `acceptOffer()` signs the seller's cat input 0 and broadcasts by
 * delegating to `accept-offer.core`'s `acceptOffer` (no duplication). There is
 * NO coin selection here — the buyer already funded the offer. State ships
 * through a plain `subscribe(listener)` callback.
 */

export type AcceptOfferOrchestratorState =
  | 'idle' | 'parsed' | 'invalid' | 'accepting' | 'success' | 'error';

export interface AcceptOfferWalletContext {
  type: KnownOrdinalWalletType;
  /** Seller's ordinals identity — the cat at input 0 belongs to it. */
  ordinalsAddress: string;
  /** Seller's ordinals pubkey hex (input 0's taproot internal key). */
  ordinalsPublicKey: string;
}

export interface AcceptOfferOrchestratorDeps {
  broadcast(signedTxHex: string): Promise<BroadcastOutcome>;
  network: Network;
}

/** The seller's decoded + validated view of a pasted offer, shown pre-sign. */
export interface AcceptOfferPreview {
  psbtBytes: Uint8Array;
  /** Cat being sold — sat 0 of this UTXO is the cat sat. */
  catUtxo: CatOutpoint;
  /** Buyer's payout — sats arriving at the seller's address. */
  pricePaidSats: number;
  /** Cat-postage that returns to the seller's payout output. */
  postageSats: number;
}

export interface AcceptOfferSnapshot {
  state: AcceptOfferOrchestratorState;
  pastedOffer: string | null;
  floorPriceSats: number | null;
  expectedCatUtxo: CatOutpoint | null;
  expectedSellerPaymentAddress: PaymentAddress | null;
  preview: AcceptOfferPreview | null;
  validationResult: Cat21OfferValidation | null;
  errorMessage: string | null;
  successTxId: string | null;
  channel: BroadcastOutcome['channel'] | null;
}

/**
 * Maximum acceptable paste size in bytes. PSBTs above this are rejected before
 * decoding to prevent OOM / tab-crash via a malicious `?offer=…` link. A real
 * CAT-21 buy-offer is <1 KB on chain; 256 KiB is generous headroom.
 */
const MAX_PASTED_OFFER_BYTES = 256 * 1024;

export class Cat21AcceptOfferOrchestrator {
  static readonly MAX_PASTED_OFFER_BYTES = MAX_PASTED_OFFER_BYTES;

  private wallet: AcceptOfferWalletContext | null = null;
  private lastWalletAddress: string | null = null;
  private humanUiOptOut = false;
  private snap: AcceptOfferSnapshot = {
    state: 'idle',
    pastedOffer: null,
    floorPriceSats: null,
    expectedCatUtxo: null,
    expectedSellerPaymentAddress: null,
    preview: null,
    validationResult: null,
    errorMessage: null,
    successTxId: null,
    channel: null,
  };
  private readonly listeners = new Set<(s: AcceptOfferSnapshot) => void>();

  constructor(private readonly deps: AcceptOfferOrchestratorDeps) {}

  getSnapshot(): AcceptOfferSnapshot {
    return this.snap;
  }

  subscribe(listener: (s: AcceptOfferSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snap);
    return () => this.listeners.delete(listener);
  }

  /** Connect / swap the seller wallet. Auto-resets the form on address change. */
  setWallet(wallet: AcceptOfferWalletContext | null): void {
    this.wallet = wallet;
    if (!wallet) {
      if (this.lastWalletAddress !== null) this.resetFormFields();
      this.lastWalletAddress = null;
      return;
    }
    if (this.lastWalletAddress === null || this.lastWalletAddress === wallet.ordinalsAddress) {
      this.lastWalletAddress = wallet.ordinalsAddress;
      return;
    }
    this.lastWalletAddress = wallet.ordinalsAddress;
    this.resetFormFields();
  }

  /**
   * Decode + validate the pasted offer. Pure transition — no wallet calls.
   * Safe to call repeatedly as the user edits. Stays `idle` until the expected
   * cat, seller payout address, AND floor are all set (without them any offer
   * could redirect payment / pass a 1-sat price).
   */
  setPastedOffer(paste: string | null): void {
    const trimmed = paste && paste.trim() ? paste.trim() : null;
    if (!trimmed) {
      this.patch({ pastedOffer: null, preview: null, validationResult: null, state: 'idle' });
      return;
    }
    if (trimmed.length > MAX_PASTED_OFFER_BYTES) {
      const msg = `Pasted offer too large: ${trimmed.length} bytes > ${MAX_PASTED_OFFER_BYTES} cap`;
      this.patch({
        pastedOffer: trimmed, errorMessage: msg, preview: null, state: 'invalid',
        validationResult: { ok: false, reason: 'malformed-offer-psbt', detail: msg },
      });
      return;
    }
    this.patch({ pastedOffer: trimmed });
    this.revalidate();
  }

  setFloorPriceSats(sats: number): void {
    if (!Number.isFinite(sats) || sats < 0) return;
    this.patch({ floorPriceSats: Math.floor(sats) });
    this.revalidate();
  }

  /**
   * Human-UI opt-out for the floor safety-net: floor stays 0 across resets (the
   * seller reads `pricePaidSats` in the summary before signing — the human is
   * the check). Bot / headless consumers must NOT call this; they set an
   * explicit floor per-run so a forgotten value can't pass a 1-sat offer.
   */
  disableFloorGate(): void {
    this.humanUiOptOut = true;
    this.patch({ floorPriceSats: 0 });
    this.revalidate();
  }

  setExpectedCatUtxo(utxo: CatOutpoint | null): void {
    this.patch({ expectedCatUtxo: utxo });
    this.revalidate();
  }

  /**
   * Set the address the seller expects the payment output (output 1) at.
   * Branded `PaymentAddress` (SDK HARD RULE "Never derive a payment address
   * from an on-chain lookup"): pass a value from the connected wallet or the
   * URL permalink, never from an ord / electrs ownership query.
   */
  setExpectedSellerPaymentAddress(address: PaymentAddress | null): void {
    this.patch({ expectedSellerPaymentAddress: address });
    this.revalidate();
  }

  /**
   * Sign the seller's cat input 0 and broadcast. Delegates to
   * `accept-offer.core`'s `acceptOffer` (validate → sign → broadcast), which
   * re-validates and refuses to sign a mismatched offer. Requires a validated
   * paste (`state === 'parsed'`) and a connected wallet.
   */
  async acceptOffer(
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Promise<string>,
  ): Promise<BroadcastOutcome> {
    const wallet = this.wallet;
    const preview = this.snap.preview;
    const expectedCat = this.snap.expectedCatUtxo;
    const expectedAddr = this.snap.expectedSellerPaymentAddress;
    const floor = this.snap.floorPriceSats;
    if (!wallet) throw new Error('No wallet connected');
    if (!preview || this.snap.state !== 'parsed') throw new Error('No validated offer to accept');
    if (!expectedCat || !expectedAddr || floor === null) throw new Error('Offer form incomplete');

    this.patch({ state: 'accepting', errorMessage: null, successTxId: null, channel: null });
    try {
      const params: AcceptOfferCoreParams = {
        walletType: wallet.type,
        network: this.deps.network,
        ordinalsAddress: wallet.ordinalsAddress,
        ordinalsPublicKey: wallet.ordinalsPublicKey,
        offerPsbt: preview.psbtBytes,
        expectedSellerUtxo: { txid: expectedCat.txid, vout: expectedCat.vout },
        floorPriceSats: floor,
        expectedSellerPaymentAddress: expectedAddr,
      };
      const outcome = await acceptOfferCore(params, {
        broadcast: { broadcast: (txHex) => this.deps.broadcast(txHex) },
        promptForSignedPsbt,
      });
      this.patch({ state: 'success', successTxId: outcome.txid, channel: outcome.channel });
      return outcome;
    } catch (err) {
      this.patch({ state: 'error', errorMessage: errMsg(err) });
      throw err;
    }
  }

  /** Wipe paste + parse result + any prior outcome. Keeps the wallet connected. */
  reset(): void {
    this.resetFormFields();
  }

  // --- internals ----------------------------------------------------------

  private revalidate(): void {
    const paste = this.snap.pastedOffer;
    if (!paste) {
      this.patch({ preview: null, validationResult: null, state: 'idle' });
      return;
    }
    let psbtBytes: Uint8Array;
    try {
      psbtBytes = decodePastedPsbt(paste);
    } catch (err) {
      const msg = errMsg(err);
      this.patch({
        errorMessage: msg, preview: null, state: 'invalid',
        validationResult: { ok: false, reason: 'malformed-offer-psbt', detail: msg },
      });
      return;
    }

    const expectedCat = this.snap.expectedCatUtxo;
    const expectedAddr = this.snap.expectedSellerPaymentAddress;
    const floor = this.snap.floorPriceSats;
    if (!expectedCat || !expectedAddr || floor === null) {
      // Form incomplete — never run the validator (see setPastedOffer doc). Stay idle.
      this.patch({ state: 'idle' });
      return;
    }

    let validation: Cat21OfferValidation;
    try {
      validation = validateCat21BuyOfferPsbt({
        psbt: psbtBytes,
        expectedSellerUtxo: expectedCat,
        floorPriceSats: floor,
        expectedSellerPaymentAddress: expectedAddr,
        network: this.deps.network,
      });
    } catch (err) {
      validation = { ok: false, reason: 'malformed-offer-psbt', detail: errMsg(err) };
    }

    if (validation.ok) {
      this.patch({
        validationResult: validation,
        errorMessage: null,
        preview: { psbtBytes, catUtxo: expectedCat, pricePaidSats: validation.pricePaidSats, postageSats: validation.postageSats },
        state: 'parsed',
      });
    } else {
      this.patch({ validationResult: validation, errorMessage: null, preview: null, state: 'invalid' });
    }
  }

  private resetFormFields(): void {
    this.patch({
      pastedOffer: null,
      preview: null,
      validationResult: null,
      // Reset floor to null so the "explicit floor required" gate fires again
      // on the next paste. Human-UI opt-out keeps 0 across resets.
      floorPriceSats: this.humanUiOptOut ? 0 : null,
      expectedCatUtxo: null,
      expectedSellerPaymentAddress: null,
      // A wallet swap must not leave a prior accept's success/error/txid on the
      // snapshot under the new wallet; return to a clean idle.
      state: 'idle',
      errorMessage: null,
      successTxId: null,
      channel: null,
    });
  }

  private patch(next: Partial<AcceptOfferSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of this.listeners) l(this.snap);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
