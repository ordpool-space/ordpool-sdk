import * as btc from '@scure/btc-signer';
import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
/**
 * Layer-1 builder for the inscribe **commit** transaction.
 *
 * Construction outline:
 *
 *   1. The reveal spends a P2TR output with a **single envelope leaf**.
 *      The **ephemeral key** is the taproot internal key — so the
 *      commit output has two equivalent spend paths:
 *        a. Script-path via the envelope leaf (used by the standard
 *           reveal — emits the inscription).
 *        b. Key-path via the ephemeral key (used by any redirect /
 *           RBF / recover / bundle reveal the consumer constructs
 *           after `createInscribeTransactions` returns).
 *      Same shape as Casey Rodarmor's `ord` reference client
 *      (`src/wallet/batch/plan.rs` lines 367-382). The ephemeral key
 *      doubles as a bearer instrument: whoever holds it can build
 *      any reveal-tx shape until the commit output is spent.
 *
 *   2. The commit transaction has:
 *        - 1 funding input (caller-supplied UTXO; user's wallet
 *          signs). Sequence is wallet-specific via
 *          `resolveCat21InputSequence(walletType)`: 0xfffffffd for
 *          cat21wallet (RBF allowed; our wallet preserves
 *          lockTime=21 through replacement), 0xfffffffe for every
 *          third-party wallet (RBF disabled; locks accelerate UIs
 *          out, the 2024 Xverse incident defence).
 *        - Output 0: the commit P2TR address holding
 *          `postage + revealFeeReserve + tipValueSats` (the last
 *          term only when `tipValueSats > 0` on the reveal). The
 *          reveal spends this.
 *        - Output 1 (optional): change back to the user, if the
 *          funding input has surplus above commit fee + output 0.
 *
 *   3. `nLockTime=21`: the commit qualifies as a CAT-21 mint under
 *      cat21-ord's `--index-cat21` rule. The first sat of vout[0]
 *      becomes Cat A (`<commitTxid>i0`). The reveal then spends
 *      vout[0] FIFO-style, moving Cat A to the inscription's UTXO,
 *      and the reveal itself (also `nLockTime=21`) mints Cat B
 *      (`<revealTxid>i0`) at the same satpoint. Net: two cats per
 *      inscribe, stacked on the inscription's 546-sat UTXO. The
 *      maintainer's design: "we gift the cats for free. because
 *      why not."
 *
 * Returns the unsigned commit PSBT bytes + the metadata the
 * reveal builder needs to construct the spending witness.
 */
/**
 * Canonical postage for inscriptions. Same 546-sat dust floor as
 * cat21 — keeps inscription UTXOs fungible across address types
 * AND matches the floor every inscriber in the OSS catalog uses.
 * See HQ rule "cat UTXO is always 546 sats, FIFO".
 */
export declare const INSCRIBE_POSTAGE_SATS = 546;
export interface InscribeCommitArgs {
    /** Funding UTXO the user's wallet will sign. */
    fundingInput: {
        txid: string;
        vout: number;
        value: number;
        scriptPubKey: Uint8Array;
        /** Set on P2TR funding inputs. Same shape as the cat21 mint adapter. */
        tapInternalKey?: Uint8Array;
        /** Set on P2SH-wrapped funding (Xverse Nested SegWit etc.). */
        redeemScript?: Uint8Array;
        /** Set on legacy P2PKH funding. */
        nonWitnessUtxo?: Uint8Array;
    };
    /** Address the user's change returns to (taproot output of the funding wallet). */
    senderChangeAddress: string;
    /** Tapscript bytes for the envelope leaf (output of `buildInscriptionEnvelope`). */
    envelopeScript: Uint8Array;
    /**
     * 32-byte x-only ephemeral public key. Doubles as:
     *   - The first push inside the envelope script (`<pubkey>
     *     CHECKSIG OP_FALSE OP_IF "ord" …`).
     *   - The taproot internal key of the commit output.
     * Holding the matching private key authorises any reveal-tx
     * shape the consumer wants to build (default reveal, redirect,
     * RBF, recover-to-self, bundle).
     */
    ephemeralPubkeyXonly: Uint8Array;
    /** Commit-tx fee in sats (built by the fee helper at Layer 3). */
    commitFeeSats: number;
    /** Reveal-tx fee in sats (reserved in commit output 0 for the reveal to pay). */
    revealFeeReserveSats: number;
    /**
     * Optional tip-output amount in sats reserved on the commit output
     * (in addition to postage + revealFeeReserve). The tip output itself
     * lives on the reveal tx at vout[1]; this is just the bookkeeping
     * the commit needs to fund it.
     *
     * When set, `commitOutputValueSats = postage + revealFeeReserve +
     * tipValueSats`; when omitted the commit output sizes exactly as
     * before. Must be a non-negative integer.
     */
    tipValueSats?: number;
    /**
     * Which wallet will sign the commit PSBT. Drives the funding
     * input's sequence number via `resolveCat21InputSequence`:
     *   - `cat21wallet`: 0xfffffffd (RBF-allowed; our wallet preserves
     *     `lockTime=21` through any replacement).
     *   - any other wallet (default): 0xfffffffe (non-RBF; locks
     *     third-party accelerate UIs out of touching the marker,
     *     defending against the 2024 Xverse incident where an
     *     accelerator dropped `lockTime=21` and burned a CAT-21 mint).
     *
     * Defaults to a non-cat21wallet sentinel so any standalone caller
     * (regtest specs, third-party SDK consumers) gets the safer
     * non-RBF sequence without having to know about the rule.
     */
    walletType?: KnownOrdinalWalletType;
    /** Per-address-type change dust limit; below this the change is absorbed into the fee. */
    changeDustLimitSats?: number;
    network: Network;
}
export interface InscribeCommitResult {
    /** Unsigned PSBT bytes ready for the user's wallet to sign. */
    commitPsbt: Uint8Array;
    /** Bech32m P2TR address the reveal will spend from. */
    commitAddress: string;
    /** scriptPubKey bytes of the commit output (same script the reveal references). */
    commitOutputScript: Uint8Array;
    /**
     * Sat value the commit places at output 0. Equals
     * `postage + revealFeeReserveSats + (tipValueSats ?? 0)`. Funds
     * the reveal's recipient output + optional tip output + reveal
     * miner fee in a single P2TR commit.
     */
    commitOutputValueSats: number;
    /** Taptree metadata the reveal builder needs to construct its spending witness. */
    taproot: {
        /** Taproot internal key actually written to the output (the ephemeral pubkey). */
        internalKey: Uint8Array;
        /**
         * scure's tapLeafScript array — single entry, for the envelope leaf.
         * The reveal builder passes this straight to the script-path reveal;
         * a key-path reveal doesn't need it.
         */
        tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
    };
    /** Change amount on output 1; 0 when sub-dust (absorbed into the fee). */
    changeSats: number;
}
export declare function buildInscribeCommitPsbt(args: InscribeCommitArgs): InscribeCommitResult;
//# sourceMappingURL=inscription-commit.helper.d.ts.map