import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { Cat21OfferBuyerInput, Cat21OfferDestinations, Cat21OfferSellerInput, Cat21OfferValidation } from './cat21-offer.types';
/**
 * Arguments for `buildCat21BuyOfferPsbt`.
 *
 * The caller is responsible for coin selection (the SDK exposes coin-selection
 * helpers in `cat21-mint`; reuse them). This function only structures the PSBT
 * and validates the SIGHASH invariant; it does not pick UTXOs, fetch them, or
 * compute fees.
 */
export interface BuildCat21BuyOfferArgs {
    /**
     * The BUYER's wallet type. Determines the input sequence number per
     * the unified per-wallet RBF policy (`resolveCat21InputSequence`):
     *   - `cat21wallet`: sequence = 0xfffffffd (RBF on; our accelerate
     *     flow preserves lockTime=21 through replacement, so signalling
     *     RBF is safe AND useful).
     *   - any other wallet: sequence = 0xfffffffe (RBF off; third-party
     *     accelerate UIs can't fire on this tx and accidentally drop the
     *     lockTime=21 marker, which would cost the buyer the cherry-on-
     *     top bonus mint cat).
     * Matches the mint/transfer flows.
     */
    walletType: KnownOrdinalWalletType;
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
/**
 * Hard cap on the raw PSBT bytes passed to the validator. Mirrors the
 * `Cat21OperationGate`'s cap so non-Angular callers (cat21-wallet,
 * scripts) get the same protection. A real CAT-21 buy-offer is <1 KB;
 * 128 KiB is generous headroom while still blocking adversarial blobs.
 */
export declare const MAX_BUY_OFFER_PSBT_BYTES: number;
export interface ValidateCat21BuyOfferArgs {
    psbt: Uint8Array;
    expectedSellerUtxo: {
        txid: string;
        vout: number;
    };
    /** Minimum acceptable price in sats. Must be supplied; 0 is legal but the caller has to type it. */
    floorPriceSats: number;
    /**
     * REQUIRED. Without this, a malicious buyer can build a PSBT whose
     * Output 1 pays anywhere (including the buyer's own change), and the
     * validator only checks the amount, not the destination. The seller
     * would sign, the cat would move, and the payment would never arrive.
     * Made mandatory as of audit C1.
     */
    expectedSellerPaymentAddress: string;
    /**
     * Network used to decode Output 1's `scriptPubKey` back to an address.
     * Defaults to mainnet. Callers signing on testnet/regtest must pass it.
     */
    network?: Network;
}
/**
 * Validates the on-the-wire shape of an inbound buy-offer PSBT.
 *
 * **Scope rule — read this before adding a check:** this validator
 * protects the SELLER. "Whose loss is this?" — gate ONLY on things
 * that hurt the seller. Buyer-side optimization losses (no bonus-mint
 * cat from a missing `lockTime=21`, SIGHASH_DEFAULT-on-Taproot when
 * the buyer wanted SIGHASH_ALL, …) are NOT the seller's problem and
 * MUST NOT be grounds for rejection — a rejected offer is a lost sale.
 * See `feedback_validator_audience_check` memory.
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