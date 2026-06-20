import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { Cat21TransferCatInput, Cat21TransferDestinations, Cat21TransferFundingInput } from './cat21-transfer.types';
/**
 * Dust threshold for the change output. 546 sats is the conservative
 * cross-address-type floor (taproot 330, segwit 294, p2sh 540 — 546
 * clears them all).
 */
export declare const CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS = 546;
/**
 * Arguments for `buildCat21TransferPsbt`.
 *
 * Coin selection is the caller's responsibility. The builder structures
 * the PSBT and pins the protocol invariants; it does NOT pick UTXOs,
 * fetch them, or compute fees.
 */
export interface BuildCat21TransferArgs {
    /**
     * Which wallet will sign this PSBT. Determines the input sequence:
     *   - `cat21wallet`: sequence = 0xfffffffd (RBF on; our accelerate
     *     flow preserves `lockTime=21` through replacement).
     *   - any other wallet: sequence = 0xfffffffe (RBF off; third-party
     *     accelerate UIs can't fire on this tx and accidentally drop
     *     the marker on replacement).
     */
    walletType: KnownOrdinalWalletType;
    network: Network;
    catUtxo: Cat21TransferCatInput;
    /**
     * Funding UTXOs that cover postage + fee above what the cat UTXO
     * already provides. May be empty when the cat UTXO is large enough
     * to self-fund.
     */
    fundingInputs: ReadonlyArray<Cat21TransferFundingInput>;
    destinations: Cat21TransferDestinations;
    /** Miner fee in sats. Caller computes from intended feeRate × vsize estimate. */
    feeSats: number;
}
export interface BuildCat21TransferResult {
    /** Raw hex of the unsigned tx. */
    hex: string;
    /** Raw PSBT bytes. */
    psbt: Uint8Array;
    /** Total funding input value (sum of fundingInputs.value). 0 when self-funded. */
    fundingInputTotalSats: number;
    /** Change output value (0 when sub-dust; absorbed into fee). */
    changeSats: number;
}
/**
 * Builds the unsigned CAT-21 transfer PSBT.
 *
 * Every cat-touching tx we build is structurally a CAT-21 mint:
 * `lockTime=21` re-mints a fresh cat onto the same ordinal that
 * already carries the original — a single ordinal can carry multiple
 * cats. The value `21` is a protocol marker (block 21 mined in 2009),
 * no consensus meaning.
 *
 * Structure:
 *   Input 0  — cat-bearing UTXO. Cat's sat is the first sat of this
 *              UTXO; ends up at the first sat of output 0 (FIFO).
 *   Input 1+ — funding UTXOs (empty when the cat UTXO has surplus).
 *   Output 0 — recipient address, postage sats. Cat lands here.
 *   Output 1 — change (absorbed into fee when sub-dust).
 *
 * Hard invariants (asserted): lockTime=21, per-wallet sequence,
 * every input SIGHASH_ALL. Coin selection is the caller's job.
 */
export declare function buildCat21TransferPsbt(args: BuildCat21TransferArgs): BuildCat21TransferResult;
//# sourceMappingURL=cat21-transfer.helper.d.ts.map