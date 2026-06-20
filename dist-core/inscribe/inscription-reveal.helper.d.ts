import * as btc from '@scure/btc-signer';
import { Network } from '../network';
/**
 * Layer-1 builder for the **reveal** transaction.
 *
 * The reveal:
 *   - Spends the commit's P2TR output (built by the commit helper)
 *     via the envelope tapscript leaf.
 *   - Witness shape: `[ephemeralSig, envelopeScript, controlBlock]`.
 *   - Has one output at index 0: `recipientAddress` for postage sats.
 *     Per ord theory, the inscription lands on the first sat of the
 *     first output.
 *
 * The reveal hex is self-contained: signed under the ephemeral
 * key, replayable, idempotent, broadcast-from-anywhere. The
 * orchestrator passes the ephemeral key here AND returns it on
 * `CreateInscribeTransactionsResult.ephemeral.privKey` so the
 * consumer can rebuild a different reveal later (redirect, RBF,
 * recover-to-self, bundle) without losing access.
 */
/** Result of `buildInscribeRevealTx`. */
export interface InscribeRevealResult {
    /** Network-serialised, finalized reveal tx (hex). */
    revealHex: string;
    /** Computed txid of the reveal. */
    revealTxid: string;
    /** vsize of the finalized reveal (used by the fee helper). */
    revealVsize: number;
}
export interface InscribeRevealArgs {
    /** Commit txid (caller broadcasts commit later; we just reference it). */
    commitTxid: string;
    /** Commit output index — always 0 for the inscriber. */
    commitVout: number;
    /** Sat value at the commit output (postage + revealFeeReserve). */
    commitOutputValueSats: number;
    /** scriptPubKey bytes of the commit output (output of commit helper). */
    commitOutputScript: Uint8Array;
    /** Taptree spend metadata (output of commit helper). */
    taproot: {
        internalKey: Uint8Array;
        tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
    };
    /**
     * 32-byte ephemeral private key. SAME key whose Schnorr x-only
     * pubkey was embedded in the envelope script the commit helper
     * placed in the taptree. The Layer-4 orchestrator generates this
     * once, hands it to the envelope builder (via `deriveRevealPubkeyXonly`)
     * AND here, then zeros it. Mismatched key → scure rejects finalize.
     */
    ephemeralPrivKey: Uint8Array;
    /** Address the inscription lands on (P2TR recommended). */
    recipientAddress: string;
    /** Network. */
    network: Network;
}
/**
 * Signs the reveal via the envelope tapscript leaf, returns the
 * finalized reveal hex. The caller-supplied ephemeral private key
 * is used for the Schnorr signature; the orchestrator returns this
 * same key on its result so the consumer can rebuild a different
 * reveal later under different parameters.
 */
export declare function buildInscribeRevealTx(args: InscribeRevealArgs): InscribeRevealResult;
/**
 * Derives the x-only Schnorr pubkey from a private key. The pubkey
 * is what gets embedded in the envelope tapscript via
 * `<revealPubkeyXonly> OP_CHECKSIG`, so the caller can pre-compute
 * the envelope independently of the actual reveal call. The same
 * pubkey is fed to both the commit helper (via envelopeScript) and
 * the reveal helper (implicitly via the regenerated private key).
 *
 * Returns the 32-byte x-only Schnorr pubkey.
 */
export declare function deriveRevealPubkeyXonly(privKey: Uint8Array): Uint8Array;
//# sourceMappingURL=inscription-reveal.helper.d.ts.map