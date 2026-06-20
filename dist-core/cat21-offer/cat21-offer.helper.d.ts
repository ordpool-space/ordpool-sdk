import { Network } from '../network';
import { Cat21OfferBuyerInput, Cat21OfferDestinations, Cat21OfferSellerInput, Cat21OfferValidation } from './cat21-offer.types';
/**
 * Sequence number set on every input of a CAT-21 buy-offer PSBT.
 *
 * `0xfffffffd` signals BIP-125 RBF — the buyer (or any party with the
 * authority to rebuild the tx) can submit a higher-fee replacement if
 * the mempool congests after broadcast. This is the SDK default for
 * non-mint cat-flows per the cat21-wallet HARD RULE #1: offers and
 * transfers allow RBF; the only flow that disables RBF is the mint
 * (and only for third-party wallets that can't be trusted to preserve
 * `lockTime=21` through a replacement — see
 * `cat21-mint/cat21.service.helper.ts:CAT21_MINT_INPUT_SEQUENCE`).
 *
 * `@scure/btc-signer`'s default sequence is `0xffffffff` (final, RBF
 * off), so this MUST be set explicitly. Verified by reading the
 * scure source (`DEFAULT_SEQUENCE = 4294967295`).
 */
export declare const CAT21_OFFER_INPUT_SEQUENCE = 4294967293;
/**
 * Arguments for `buildCat21BuyOfferPsbt`.
 *
 * The caller is responsible for coin selection (the SDK exposes coin-selection
 * helpers in `cat21-mint`; reuse them). This function only structures the PSBT
 * and validates the SIGHASH invariant; it does not pick UTXOs, fetch them, or
 * compute fees.
 */
export interface BuildCat21BuyOfferArgs {
    network: Network;
    sellerInput: Cat21OfferSellerInput;
    buyerInputs: Cat21OfferBuyerInput[];
    destinations: Cat21OfferDestinations;
    /**
     * Sats paid to the seller (net). The seller's payment output value is
     * `priceSats + CAT21_POSTAGE_SATS` so the seller is made whole on the
     * 546 sats they contribute via input 0 (ord-parity, see SDK CLAUDE.md
     * HARD RULE "cat UTXO is always 546 sats").
     */
    priceSats: number;
    /**
     * Miner fee in sats. Caller computes this from the chosen feeRate and the
     * estimated tx size (use `getBitcoinTransactionFee` from `cat21-mint` or any
     * equivalent). The builder does not compute fees because the buyer-funded
     * UTXOs may live in two different script types and only the caller knows
     * the correct size estimator.
     */
    feeSats: number;
}
export interface BuildCat21BuyOfferResult {
    /** Raw hex of the unsigned tx (input 0 carries no buyer signature). */
    hex: string;
    /** Raw PSBT bytes. */
    psbt: Uint8Array;
    /** Total buyer-funded input value (sum of buyerInputs.value). */
    buyerInputTotalSats: number;
    /** Change output value (may be 0 when sub-dust; absorbed into fee). */
    changeSats: number;
}
/**
 * Builds the buyer-initiated CAT-21 offer PSBT (ord-style,
 * SIGHASH_ALL on every input).
 *
 * Structure:
 *   Input 0  — seller's cat UTXO. Witness data is pre-populated
 *              (scriptPubKey + value) so the seller can sign
 *              without a round-trip. UNSIGNED on emit.
 *   Input 1+ — buyer's funding UTXOs. All SIGHASH_ALL.
 *   Output 0 — buyer's receive address, postage sats. Cat lands here.
 *   Output 1 — seller's payment address, `priceSats`.
 *   Output 2 — buyer's change (absorbed into fee when sub-dust).
 *
 * Sniping-proof: when the PSBT leaves the buyer it's missing only
 * the seller's signature. Once the seller signs (SIGHASH_ALL),
 * every byte is committed by some signature — no half-signed PSBT
 * can be spliced into a sniping tx.
 */
export declare function buildCat21BuyOfferPsbt(args: BuildCat21BuyOfferArgs): BuildCat21BuyOfferResult;
/**
 * Arguments for `validateCat21BuyOfferPsbt` (seller-side).
 *
 * Before the seller signs an inbound buy-offer PSBT, the structure is checked
 * against the deal the seller actually agreed to. Any mismatch surfaces as a
 * typed `Cat21OfferRejectionReason` so the UI can render a precise reason
 * without leaking unrelated PSBT details.
 */
export interface ValidateCat21BuyOfferArgs {
    psbt: Uint8Array;
    expectedSellerUtxo: {
        txid: string;
        vout: number;
    };
    /** Minimum acceptable price in sats. */
    floorPriceSats: number;
    /**
     * Strongly recommended whenever a human eventually signs. When set, the
     * validator decodes Output 1's `scriptPubKey` back to an address string
     * and compares it against this value; mismatch returns
     * `'payment-output-wrong-address'`. Omitting it leaves the address
     * un-checked (pre-2026-06 behaviour, retained for backwards-compat).
     */
    expectedSellerPaymentAddress?: string;
    /**
     * Network used to decode Output 1's `scriptPubKey` back to an address.
     * Defaults to mainnet. Callers signing on testnet/regtest must pass it.
     */
    network?: Network;
}
/**
 * Validates the on-the-wire shape of an inbound buy-offer PSBT.
 *
 *   1. Input 0 references the seller's cat UTXO.
 *   2. Every input has `sighashType === SIGHASH_ALL` (or undefined
 *      for already-finalised inputs — the embedded signature itself
 *      commits to its sighash).
 *   3. Every input 1..N carries a buyer signature (partialSig,
 *      tapKeySig, or finalScriptWitness).
 *   4. Output 0 (cat) postage ≥ configured minimum.
 *   5. Output 1 (seller payment) ≥ floor price.
 *   6. When `expectedSellerPaymentAddress` is supplied, Output 1's
 *      script is decoded and compared. Strongly recommended whenever
 *      a human eventually signs — the validator is the single source
 *      of truth and can't delegate to a UI layer that may or may
 *      not exist.
 */
export declare function validateCat21BuyOfferPsbt(args: ValidateCat21BuyOfferArgs): Cat21OfferValidation;
//# sourceMappingURL=cat21-offer.helper.d.ts.map