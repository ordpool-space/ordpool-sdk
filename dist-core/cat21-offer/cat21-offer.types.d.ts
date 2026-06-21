/**
 * Alias for {@link CAT21_POSTAGE_SATS} kept for legacy import paths. The
 * canonical constant lives in `cat21-postage.ts`; every cat-touching tx
 * uses the same value across mint, transfer, and offer flows.
 */
export declare const CAT21_OFFER_POSTAGE_SATS = 546;
/**
 * Description of the cat-bearing UTXO the offer is bidding on. The buyer
 * must know the seller's UTXO precisely so they can reference it in the
 * offer PSBT without a round-trip to the seller before signing.
 */
export interface Cat21OfferSellerInput {
    txid: string;
    vout: number;
    /** Sats locked in the cat-bearing UTXO. Usually 546, caller passes through. */
    value: number;
    /** scriptPubKey of the seller's UTXO, raw bytes. */
    scriptPubKey: Uint8Array;
}
/**
 * Buyer-funded input the offer PSBT borrows to cover price + fee + postage.
 * Caller pre-selects these via the SDK's coin-selection logic (or its own);
 * the offer builder does NOT coin-select.
 */
export interface Cat21OfferBuyerInput {
    txid: string;
    vout: number;
    value: number;
    scriptPubKey: Uint8Array;
    /**
     * For taproot inputs, the x-only internal public key. When set, the input
     * gets `tapInternalKey` populated so a taproot signer can produce a valid
     * key-path signature.
     */
    tapInternalKey?: Uint8Array;
    /** For P2SH-wrapped SegWit (Xverse / Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /**
     * For legacy P2PKH inputs (Unisat-Legacy). Full previous-tx bytes —
     * scure refuses to sign legacy inputs from witnessUtxo alone.
     */
    nonWitnessUtxo?: Uint8Array;
}
/** Output destinations of an ord-style offer. */
export interface Cat21OfferDestinations {
    /** Where the cat lands. The first sat of this output ends up holding the cat. */
    buyerReceiveAddress: string;
    /** Where the buyer's BTC payment goes. */
    sellerPaymentAddress: string;
    /** Where buyer change goes (when above dust). */
    buyerChangeAddress: string;
}
/** Reasons a seller-side validator may reject an inbound offer PSBT. */
export type Cat21OfferRejectionReason = 'missing-seller-input' | 'wrong-postage' | 'wrong-price' | 'wrong-seller-input-value' | 'sighash-not-all' | 'sighash-flag-byte-not-all' | 'buyer-input-unsigned' | 'missing-seller-payment-output' | 'payment-output-wrong-address' | 'cat-output-not-spendable' | 'lock-time-not-21';
export interface Cat21OfferValidationResult {
    ok: true;
    pricePaidSats: number;
    postageSats: number;
}
export interface Cat21OfferValidationFailure {
    ok: false;
    reason: Cat21OfferRejectionReason;
    detail?: string;
}
export type Cat21OfferValidation = Cat21OfferValidationResult | Cat21OfferValidationFailure;
//# sourceMappingURL=cat21-offer.types.d.ts.map