/**
 * Ord-protocol field tags. Mirrors ordpool-parser's `knownFields`
 * value-for-value. See https://docs.ordinals.com/inscriptions.html
 * for the canonical reference.
 */
export declare const ORD_TAGS: {
    /** MIME type of the body. */
    readonly content_type: 1;
    /** Override placement on a sat other than the first. */
    readonly pointer: 2;
    /** Parent inscription id for provenance chains. */
    readonly parent: 3;
    /** CBOR-encoded metadata. */
    readonly metadata: 5;
    /** Metaprotocol identifier string. */
    readonly metaprotocol: 7;
    /** Body encoding hint (`br` for brotli). */
    readonly content_encoding: 9;
    /** Delegate inscription id (point to another inscription's body). */
    readonly delegate: 11;
    /** Rune-name commitment for rune etching pre-commit. */
    readonly rune: 13;
    /** Reserved Tag::Note; de facto inscriber-tool watermark. */
    readonly note: 15;
    /** CBOR-encoded gallery items + attributes. */
    readonly properties: 17;
    /** Encoding for properties (`br` for brotli). */
    readonly property_encoding: 19;
};
export type OrdTag = typeof ORD_TAGS[keyof typeof ORD_TAGS];
/**
 * A single tag/value pair embedded in the envelope before the body.
 * The encoder serialises each as `<tag-push> <value-push>`.
 */
export interface OrdEnvelopeField {
    tag: OrdTag;
    value: Uint8Array;
}
export interface BuildInscriptionEnvelopeArgs {
    /**
     * x-only Schnorr pubkey (32 bytes) that signs the reveal. Embedded
     * AFTER the envelope as `<pubkey> OP_CHECKSIG` — the actual
     * spending condition. The envelope itself sits inside a dead
     * `OP_FALSE OP_IF ... OP_ENDIF` branch and is never executed.
     */
    revealPubkeyXonly: Uint8Array;
    /**
     * MIME type encoded as UTF-8 bytes. Encoded as tag 1
     * (`content_type`).
     */
    contentType?: string;
    /**
     * Body bytes (raw inscription content). Sliced into 520-byte
     * pushes after the OP_0 separator. Pass an empty Uint8Array for
     * inscriptions whose body lives elsewhere (delegate, metadata-only).
     */
    body: Uint8Array;
    /**
     * Additional tags (parent, metadata, metaprotocol, etc.). Order
     * is preserved in the encoded envelope but order doesn't affect
     * the on-chain inscription's resolved fields — ord's decoder
     * indexes by tag, not position.
     */
    fields?: ReadonlyArray<OrdEnvelopeField>;
}
/**
 * Builds the inscription tapscript: the bytes that hash into a
 * tapscript leaf on the commit address, and that the reveal tx
 * provides as witness when spending via the envelope leaf.
 *
 * Structure (per ord protocol):
 *
 * ```
 * <revealPubkeyXonly>                    (32-byte push)
 * OP_CHECKSIG
 * OP_FALSE                               (0x00)
 * OP_IF                                  (0x63)
 *   "ord"                                (3-byte push)
 *   [for each field:]
 *     <tag>                              (OP_N for tag ≤ 16, else 1-byte push)
 *     <value>                            (variable push)
 *   OP_0                                 (separator before body)
 *   [for each body chunk (≤ 520 bytes):]
 *     <chunk>
 * OP_ENDIF                               (0x68)
 * ```
 *
 * The `OP_FALSE OP_IF ... OP_ENDIF` block is provably-dead code:
 * script execution never enters the IF branch because the top of
 * stack is OP_FALSE. The bytes are still committed to in the
 * tapleaf hash, which is what carries the inscription on-chain.
 * The actual spending check is the `<pubkey> OP_CHECKSIG` PREFIX,
 * which ord's protocol places before the dead envelope.
 *
 * Returns the encoded tapscript bytes ready for taproot leaf
 * inclusion via `btc.p2tr(..., { script, leafVersion: 0xc0 })`.
 */
export declare function buildInscriptionEnvelope(args: BuildInscriptionEnvelopeArgs): Uint8Array;
/**
 * Encode a parent inscription id (`<txid>i<index>`) into the byte
 * form ord expects on tag 0x03 (`parent`) values:
 *
 *   [ 32 bytes: reversed txid ][ 0..4 bytes: little-endian index, trailing zeros trimmed ]
 *
 * Zero-index gets no trailing bytes; index 256 encodes as `[0x00, 0x01]`;
 * index 0xFFFFFFFF (u32 max) encodes as `[0xFF, 0xFF, 0xFF, 0xFF]`.
 *
 * Byte-for-byte inverse of `ordpool-parser`'s `extractInscriptionId`,
 * which is what ordpool renders inscriptions from. If the round-trip
 * doesn't match, the parser drops the parent silently (ord's
 * `filter_map` semantics), so the caller MUST hand us a canonical id
 * form.
 */
export declare function encodeParentInscriptionId(inscriptionId: string): Uint8Array;
//# sourceMappingURL=inscription-envelope.d.ts.map