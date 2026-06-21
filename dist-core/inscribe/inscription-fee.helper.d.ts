import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { type InscribeCommitArgs } from './inscription-commit.helper';
import { type OrdEnvelopeField } from './inscription-envelope';
/**
 * Layer-3 fee simulation for the inscribe commit + reveal pair.
 *
 * The two transactions pay independent fees at the same `feeRate`:
 *
 *   commit_fee = ceil(commitVsize × feeRate)
 *   reveal_fee = ceil(revealVsize × feeRate)
 *
 * The reveal's vsize is **deterministic given the envelope** (input
 * = commit output, output = recipient at postage, witness =
 * envelope script + Schnorr sig + control block) so we compute it
 * once via a one-shot simulation. The commit's vsize depends on
 * whether the change output crosses the dust limit at the
 * resolved fee, so we run the cat21-style two-pass loop on the
 * commit alone, passing `revealFeeReserveSats = reveal_fee`.
 *
 * Net cost: 1 reveal simulation + 2 commit simulations = 3 builds.
 *
 * Universal fee strategy that matches every inscriber in the
 * verified OSS catalog (ord client, micro-ordinals examples,
 * oyl-sdk, ordit-sdk, 0xFlicker, LaserEyes — see
 * OSS-INSCRIBERS.md). No zero-fee tricks, no CPFP magic; the
 * atomicity story is `submitpackage` at broadcast time, which
 * handles its own package-feerate math.
 */
export interface SimulateInscribeFeesArgs {
    /** sat/vB target fee rate. Same rate applies to both commit + reveal. */
    feeRatePerVbyte: number;
    /** Inscription body bytes. Shape-determines reveal vsize. */
    body: Uint8Array;
    /** MIME type encoded into the envelope. */
    contentType?: string;
    /** Optional extra envelope fields (parent, metaprotocol, metadata...). */
    envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
    /**
     * Funding-input shape — the same `InscribeFundingInput` the commit
     * helper consumes. The Layer-2 adapter produces this.
     */
    fundingInput: InscribeCommitArgs['fundingInput'];
    /** Where the user's change returns to. */
    senderChangeAddress: string;
    /** Where the inscription lands. */
    recipientAddress: string;
    /**
     * 32-byte x-only ephemeral pubkey used as the taproot internal key
     * AND embedded in the envelope's `<pubkey> CHECKSIG` prefix. Real
     * orchestrator passes the freshly-generated key; specs may pass a
     * deterministic dummy because vsizes don't depend on key bytes.
     */
    ephemeralPubkeyXonly: Uint8Array;
    /**
     * Optional reveal-tx tip output. Threads through to the reveal
     * vsize estimate (extra output bytes) AND the commit's
     * `tipValueSats` so the commit funds postage + revealFee + tip.
     */
    tip?: {
        address: string;
        value: number;
    };
    /**
     * Wallet whose signature topology drives the commit's funding-
     * input sequence. Threaded through to `buildInscribeCommitPsbt`.
     * Optional; defaults to the safer non-RBF sequence when omitted.
     */
    walletType?: KnownOrdinalWalletType;
    /** Per-address-type dust limit for the commit change. */
    changeDustLimitSats?: number;
    network: Network;
}
export interface SimulateInscribeFeesResult {
    /** Final commit-tx fee in sats. */
    commitFeeSats: number;
    /** Final reveal-tx fee in sats. */
    revealFeeSats: number;
    /** commitFeeSats + revealFeeSats. The "total fee burden" for UI display. */
    totalFeeSats: number;
    /** Commit vsize at final fee. */
    commitVsize: number;
    /** Reveal vsize (deterministic given the envelope). */
    revealVsize: number;
    /** commitVsize + revealVsize. Useful for package-feerate math. */
    combinedVsize: number;
    /** Amount the commit output 0 holds = postage + revealFeeSats. */
    commitOutputValueSats: number;
    /** Total sats the funding UTXO must cover: commitOutputValueSats + commitFeeSats. */
    fundingRequirementSats: number;
}
/**
 * Returns the commit + reveal fee math at the given fee rate.
 * Pure function — does not broadcast, does not retain any key
 * material between calls.
 */
export declare function simulateInscribeFees(args: SimulateInscribeFeesArgs): SimulateInscribeFeesResult;
/**
 * Re-exports for consumers that want the underlying primitive.
 */
export { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
/**
 * Re-export for consumers that need to forward the field-array.
 */
export type { OrdEnvelopeField } from './inscription-envelope';
//# sourceMappingURL=inscription-fee.helper.d.ts.map