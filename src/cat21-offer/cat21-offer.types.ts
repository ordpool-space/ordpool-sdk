import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Cat21PreparedInput } from '../cat21-script/prepare-cat21-input';
import { CatOutpoint } from '../cat21-share/cat-outpoint';

/**
 * What the buyer needs to know about the cat they want to bid on. A consumer
 * fetches this from ord: cat number → inscription → current UTXO at the
 * seller's address. The PSBT pre-populates input 0's `witnessUtxo` from these
 * bytes so the seller can sign offline (the buyer-initiated, sniping-proof
 * property of ord-style offers).
 */
export interface BuyOfferTargetCat extends CatOutpoint {
  catNumber: number;
  /**
   * The cat UTXO's real on-chain value (any size). Fed straight to the offer
   * builder's `sellerInput.value`, so it MUST be the actual prevout value,
   * never a hardcoded 546: a wrong amount makes the seller's signature invalid
   * and the offer un-broadcastable.
   */
  value: number;
  /** scriptPubKey of the seller's cat UTXO, raw bytes. */
  scriptPubKey: Uint8Array;
}

/**
 * Alias for {@link CAT21_POSTAGE_SATS} kept for legacy import paths. The
 * canonical constant lives in `cat21-postage.ts`; every cat-touching tx
 * uses the same value across mint, transfer, and offer flows.
 */
export const CAT21_OFFER_POSTAGE_SATS = CAT21_POSTAGE_SATS;

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
 * the offer builder does NOT coin-select. Same prepared-input shape as
 * every other cat-touching flow ({@link Cat21PreparedInput}).
 */
export type Cat21OfferBuyerInput = Cat21PreparedInput;

/** Output destinations of an ord-style offer. */
export interface Cat21OfferDestinations {
  /** Where the cat lands. The first sat of this output ends up holding the cat. */
  buyerReceiveAddress: string;
  /** Where the buyer's BTC payment goes. */
  sellerPaymentAddress: string;
  /** Where buyer change goes (when above dust). */
  buyerChangeAddress: string;
}

/**
 * Reasons the buy-offer validator may reject an inbound PSBT.
 *
 * Split by audience:
 *   - Seller-side: caller cares that the deal they'd sign matches the
 *     deal they think they're signing (input 0, seller payment, sighash,
 *     etc.). These fire whether or not any buyer-side expectation is
 *     supplied.
 *   - Marketplace / buyer-side: `cat-output-wrong-address`,
 *     `change-output-wrong-address`, `wrong-price-exact` only fire when
 *     the corresponding `expected*` arg is supplied. A bare seller-side
 *     caller (no marketplace context) never sees them.
 */
export type Cat21OfferRejectionReason =
  | 'malformed-offer-psbt'
  | 'missing-seller-input'
  | 'wrong-postage'
  | 'wrong-price'
  | 'wrong-price-exact'
  | 'wrong-seller-input-value'
  | 'sighash-not-all'
  | 'sighash-flag-byte-not-all'
  | 'buyer-input-unsigned'
  | 'missing-seller-payment-output'
  | 'payment-output-wrong-address'
  | 'cat-output-not-spendable'
  | 'cat-output-wrong-address'
  | 'change-output-wrong-address';

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

export type Cat21OfferValidation =
  | Cat21OfferValidationResult
  | Cat21OfferValidationFailure;
