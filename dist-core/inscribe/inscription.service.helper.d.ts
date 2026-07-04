import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { type OrdEnvelopeField } from './inscription-envelope';
import { type SimulateInscribeFeesResult } from './inscription-fee.helper';
/**
 * Layer-4 orchestration entry: ties the envelope encoder + per-
 * wallet input adapter + commit/reveal builders + fee simulator
 * into a single createTransaction-style entry point.
 *
 * Mirrors `createTransaction` from `cat21.service.helper.ts`. The
 * caller hands in the funding UTXO + wallet payment context + the
 * inscription content + feeRate; we hand back an unsigned commit
 * PSBT + a default signed reveal hex + the **ephemeral key material**
 * needed to build any other reveal shape (redirect, RBF, recover-
 * to-self, bundle).
 *
 * # Free cats (the "ordpool inscribers get cats" design)
 *
 * Both the commit AND the reveal carry `nLockTime=21`, so cat21-ord
 * mints TWO cats per inscription:
 *   - Cat A: `<commitTxid>i0` — minted by the commit; ends up at
 *     the inscription's UTXO via FIFO transitivity through the
 *     reveal's input.
 *   - Cat B: `<revealTxid>i0` — minted by the reveal at the same
 *     satpoint. Post-jubilee chains tag Cat B with the `Vindicated`
 *     charm; it's otherwise a normal cat with a positive number.
 * Both cats stack on the inscription's 546-sat UTXO at the
 * recipient's address. No opt-out. See the commit helper's module
 * doc for the cat21-ord index mechanics.
 *
 * # Lifecycle
 *
 *  1. Generate fresh ephemeral keypair (32 random bytes).
 *  2. Derive Schnorr x-only pubkey — this doubles as the envelope's
 *     `<pubkey> CHECKSIG` prefix AND the taproot internal key of the
 *     commit output.
 *  3. Build envelope with caller's content + auto-prepended fields
 *     (note → tag 0x0f UTF-8; contentEncoding='br' → tag 0x09 "br")
 *     + any caller-supplied `envelopeFields`.
 *  4. Simulate fees (Layer 3): commitFee, revealFee,
 *     commitOutputValueSats (= postage + revealFee + tip.value),
 *     fundingRequirementSats.
 *  5. Build the commit PSBT at the resolved commitFee with
 *     `nLockTime=21` and the per-wallet sequence.
 *  6. Build a default reveal tx at the resolved revealFee using the
 *     ephemeral private key (recipient = `args.recipientAddress`,
 *     optional tip at vout[1], also `nLockTime=21`).
 *  7. Return the ephemeral key material so the caller can re-build
 *     the reveal under different parameters later if it wants to.
 *
 * # Bearer-key semantic
 *
 * `ephemeral.privKey` is a **bearer instrument**: anyone who holds
 * it can spend the commit output (redirect the inscription, RBF the
 * reveal, recover the postage to themselves, ...) until the commit
 * output is spent on chain. Treat it with the same care as any
 * other money-bearing key:
 *
 *   - Phase 1 storage: `localStorage` keyed by `commitTxid` is fine
 *     for typical low-value inscriptions. The key lives only
 *     between commit broadcast and reveal broadcast (seconds to
 *     hours typically).
 *   - For higher-value flows, encrypt at rest with the wallet
 *     password — same posture as any other hot key.
 *   - Lose the key with no reveal broadcast and the postage is
 *     permanently locked. Save it before discarding the result.
 *
 * This is byte-equivalent to the `ord` reference client's design
 * (`src/wallet/batch/plan.rs` lines 367-382 + 676-709) — ord
 * persists the ephemeral key into Bitcoin Core's wallet under a
 * `commit tx recovery key` label; we hand it to the consumer to
 * persist however it wants.
 */
export interface CreateInscribeTransactionsArgs {
    /** Funding UTXO. */
    paymentOutput: TxnOutput;
    /** Wallet's payment public key (33-byte compressed). */
    paymentPublicKey: Uint8Array;
    /** Wallet's payment address (where change returns). */
    paymentAddress: string;
    /** Where the inscription lands (P2TR recommended for ord theory). */
    recipientAddress: string;
    /** Inscription body bytes. */
    body: Uint8Array;
    /** MIME type. */
    contentType?: string;
    /** Optional extra ord tags (parent, metaprotocol, metadata...). */
    envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
    /** sat/vB target. Applied identically to commit + reveal. */
    feeRatePerVbyte: number;
    /**
     * Which wallet will sign the commit. Drives the funding-input
     * sequence number on the commit (cat21wallet → RBF allowed; every
     * other wallet → RBF disabled). Optional; the safer non-RBF
     * sequence applies when omitted, which is what every third-party
     * wallet should ship anyway.
     *
     * Ordpool inscriptions ALWAYS build the commit with
     * `nLockTime=21` regardless of wallet — see the module-level
     * docstring for the "free cat for inscribers" design.
     */
    walletType?: KnownOrdinalWalletType;
    /**
     * Optional tip output appended at vout[1] of the reveal tx. The
     * inscription stays at vout[0] per ord's first-sat-of-first-output
     * rule. The commit's funding requirement grows by `tip.value` so
     * the reveal has the sats to fund the extra output.
     *
     * The SDK ships no default tip address — consumers (ordpool.space,
     * cat21.space, future inscribers) wire their own default. Pattern
     * mirrors `0xFlicker/ordinals`' `feeDestinations`, simplified to
     * one recipient and a fixed sats amount.
     */
    tip?: {
        address: string;
        value: number;
    };
    /**
     * Optional Tag::Note (0x0f) string. Emitted as a UTF-8 envelope
     * field; ordpool-parser surfaces it on the inscription record.
     * The de-facto inscriber-tool watermark slot.
     *
     * When set, the SDK auto-builds the `{ tag: 0x0f, value: utf8(note) }`
     * field and prepends it to `envelopeFields`.
     */
    note?: string;
    /**
     * Optional parent inscription id (`<txid>i<index>`) for provenance
     * chains. Emitted as a Tag::Parent (0x03) envelope field.
     *
     * IMPORTANT: setting this ONLY emits the envelope tag. Ord treats
     * an inscription as a genuine child only when the reveal tx ALSO
     * spends the parent's UTXO as an input — which requires the
     * parent owner co-signing the reveal, a topology change this
     * builder does not model. Consumers using `parent` today get the
     * annotation (ordpool-parser surfaces the parent id), not the
     * provenance link. Full parent/child support needs its own
     * orchestrator.
     */
    parent?: string;
    /**
     * Optional body-encoding hint. When set to `'br'`, the SDK emits
     * the `content_encoding: br` envelope tag — signalling to indexers
     * that the body is brotli-compressed. The body must already be
     * brotli-compressed by the caller (use `compressBrotli` from
     * `inscribe-brotli.helper.ts`); this flag only emits the tag.
     *
     * Split between caller-side compression and SDK-side tag emission
     * because brotli encoders are environment-specific (Node `zlib`
     * vs browser `CompressionStream`) and benefit from being async,
     * but the inscribe builder is sync.
     */
    contentEncoding?: 'br';
    /** Network. */
    network: Network;
}
export interface CreateInscribeTransactionsResult {
    /** Unsigned commit PSBT — hand to the user's wallet for signing. */
    commitPsbt: Uint8Array;
    /**
     * Computed txid of the commit. SegWit txids are witness-independent,
     * so this matches what the wallet-signed commit will produce.
     */
    commitTxid: string;
    /** Signed, finalized reveal-tx hex. Self-contained; broadcast as-is. */
    revealHex: string;
    /** Computed txid of the reveal (lets consumers display/track before broadcast). */
    revealTxid: string;
    /** Commit-tx P2TR address (bech32m). */
    commitAddress: string;
    /** Final fees (sats), vsizes, and the funding requirement. */
    fees: SimulateInscribeFeesResult;
    /**
     * Ephemeral bearer key for the commit output. Authorises any
     * reveal-tx shape (default reveal, redirect, RBF, recover-to-
     * self, bundle) until the commit output is spent. SAVE BEFORE
     * DISCARDING THIS RESULT — losing the key with no reveal
     * broadcast locks the postage forever.
     */
    ephemeral: {
        /** 32-byte Schnorr private key. */
        privKey: Uint8Array;
        /** 32-byte x-only public key. Same key embedded in the envelope. */
        pubkeyXonly: Uint8Array;
    };
    /** Material the caller needs to rebuild the reveal tx under different parameters. */
    commit: {
        /** Commit output scriptPubKey. */
        outputScript: Uint8Array;
        /** Postage + revealFeeReserve at the commit output. */
        outputValueSats: number;
        /** Envelope tapscript bytes (the leaf the reveal spends through). */
        envelopeScript: Uint8Array;
    };
}
/**
 * Build the inscribe commit + reveal pair for the given content.
 * Pure function modulo `randomPrivateKey`.
 *
 * The returned `ephemeral.privKey` is the bearer instrument for
 * the commit output — see the module-level lifecycle note for the
 * storage semantic.
 */
export declare function createInscribeTransactions(args: CreateInscribeTransactionsArgs): CreateInscribeTransactionsResult;
//# sourceMappingURL=inscription.service.helper.d.ts.map