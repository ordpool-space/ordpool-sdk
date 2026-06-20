import * as btc from '@scure/btc-signer';
import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
/**
 * Alias for {@link CAT21_POSTAGE_SATS}. The canonical constant lives in
 * `cat21-postage.ts`; this re-export exists for legacy import paths.
 */
export declare const CAT21_MINT_POSTAGE_SATS = 546;
/**
 * Dust threshold for the change output. 546 sats is the conservative
 * cross-address-type floor (taproot 330, segwit 294, p2sh 540 — 546
 * clears them all).
 */
export declare const CAT21_MINT_CHANGE_DUST_LIMIT_SATS = 546;
/**
 * Funding UTXO that pays postage + miner fee + optional tip. Coin
 * selection is the caller's job; the builder does not select.
 *
 * Per-address-shape fields (set what applies; `prepareMintInputForWallet`
 * does this automatically):
 *   - SegWit v0 (P2WPKH): `scriptPubKey` only.
 *   - P2SH-wrapped SegWit: `scriptPubKey` + `redeemScript`.
 *   - Taproot key-path: `scriptPubKey` + `tapInternalKey`.
 *   - Legacy P2PKH: `scriptPubKey` + `nonWitnessUtxo` (full
 *     previous-tx bytes; scure requires this for legacy inputs).
 */
export interface Cat21MintFundingInput {
    txid: string;
    vout: number;
    value: number;
    /** scriptPubKey bytes. */
    scriptPubKey: Uint8Array;
    /** For taproot inputs, the x-only internal public key. */
    tapInternalKey?: Uint8Array;
    /** For P2SH-wrapped SegWit inputs (Xverse, Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /**
     * For legacy P2PKH inputs (Unisat-Legacy). Full previous transaction
     * bytes — scure refuses to sign legacy inputs from witnessUtxo alone.
     */
    nonWitnessUtxo?: Uint8Array;
}
/** Output destinations of a CAT-21 mint. */
export interface Cat21MintDestinations {
    /** Where the freshly-minted cat lands. */
    recipientAddress: string;
    /** Where the funder's BTC change goes (when above dust). */
    senderChangeAddress: string;
    /** Optional developer-tip output. Skip by setting value to 0. */
    tip?: {
        address: string;
        valueSats: number;
    };
}
export interface BuildCat21MintArgs {
    /**
     * Which wallet will sign this PSBT. Determines the input sequence:
     *   - `cat21wallet`: sequence = 0xfffffffd (RBF on; our accelerate
     *     flow preserves `lockTime=21` through replacement).
     *   - any other wallet: sequence = 0xfffffffe (RBF off; third-party
     *     accelerate UIs can't fire and drop the marker on replacement
     *     — the 2024 Xverse-incident defence).
     */
    walletType: KnownOrdinalWalletType;
    network: Network;
    fundingInput: Cat21MintFundingInput;
    destinations: Cat21MintDestinations;
    /** Miner fee in sats. Caller computes from intended feeRate × vsize estimate. */
    feeSats: number;
    /**
     * Optional dust limit for the CHANGE output. Defaults to
     * `CAT21_MINT_CHANGE_DUST_LIMIT_SATS = 546` (cross-address-type
     * conservative floor). The cat21.space orchestrator passes a
     * per-address-type value via `getMinimumUtxoSize(paymentAddress)`
     * (P2TR 330, P2WPKH 294, P2SH 540) for marginally tighter dust
     * absorption when the change goes to a Taproot address.
     *
     * NOTE: this does NOT change the cat OUTPUT postage — that's
     * always 546 (HARD RULE). Only the threshold below which the
     * change output gets absorbed into the miner fee.
     */
    changeDustLimitSats?: number;
}
export interface BuildCat21MintResult {
    /** The constructed scure Transaction (unfinalized, ready for signing). */
    tx: btc.Transaction;
    /** Raw hex of the unsigned tx. */
    hex: string;
    /** Raw PSBT bytes. */
    psbt: Uint8Array;
    /** Change output value (0 when sub-dust; absorbed into fee). */
    changeSats: number;
    /**
     * Actual miner fee in sats — this is `feeSats + absorbedSubDustChange`.
     * When the change crossed the dust limit it gets absorbed into the
     * fee here; callers that report the realised fee back to the user
     * should use this field, not the input `feeSats`.
     */
    finalFeeSats: number;
}
/**
 * Builds the unsigned CAT-21 mint PSBT — the simplified wallet-friendly
 * shape parallel to `buildCat21TransferPsbt` and
 * `buildCat21BuyOfferPsbt`. For the full multi-wallet path with
 * Unisat-specific script handling, see `createTransaction` in
 * `cat21.service.helper.ts`.
 *
 * Structure:
 *   Input 0  — funding UTXO. The first sat of this UTXO becomes the
 *              first sat of output 0 by ordinal-theory FIFO, which is
 *              where cat21-ord mints the new cat.
 *   Output 0 — recipient address, postage sats. Cat lands here.
 *   Output 1 — optional developer-tip output (skipped when value=0).
 *   Output N — change to sender (skipped when sub-dust; absorbed into
 *              miner fee). N = 1 with no tip, N = 2 with tip.
 *
 * Hard invariants (asserted before return):
 *   1. `lockTime === 21`.
 *   2. Every input's sequence matches the per-wallet rule.
 *   3. Every input carries SIGHASH_ALL.
 */
export declare function buildCat21MintPsbt(args: BuildCat21MintArgs): BuildCat21MintResult;
//# sourceMappingURL=cat21-mint.helper.d.ts.map