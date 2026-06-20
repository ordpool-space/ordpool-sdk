"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORD_TAGS = void 0;
exports.buildInscriptionEnvelope = buildInscriptionEnvelope;
const btc_signer_1 = require("@scure/btc-signer");
/**
 * Inscription envelope encoder — the inverse of `ordpool-parser`'s
 * `InscriptionParserService`. Produces the tapscript bytes that
 * commit to inscription content under the ord protocol.
 *
 * Vendoring decision: this is ~150 lines of pure encoding, no
 * external deps. micro-ordinals v0.4.0 requires
 * @scure/btc-signer@^2.2.0 but the SDK is pinned to 1.2.x (the
 * consumer constraint from ordpool/frontend's lockfile). Rather
 * than fork micro-ordinals to a v1-compatible branch, we write
 * our own thin encoder against scure 1.2.x. The encoder's
 * correctness is pinned by a reversibility spec
 * (`inscription-envelope.spec.ts`) that round-trips every tag
 * through ordpool-parser's decoder and asserts byte equality.
 *
 * Tag dictionary is intentionally grep-compatible with
 * ordpool-parser/src/inscription/inscription-parser.service.helper.ts:10
 * (`knownFields`). Same numeric values, same names. If the
 * decoder ever adds a new tag, mirror it here and add a
 * round-trip case to the spec.
 */
/** ASCII bytes for the protocol marker "ord" inside the envelope. */
const ORD_MARKER = new Uint8Array([0x6f, 0x72, 0x64]);
/**
 * Ord-protocol field tags. Mirrors ordpool-parser's `knownFields`
 * value-for-value. See https://docs.ordinals.com/inscriptions.html
 * for the canonical reference.
 */
exports.ORD_TAGS = {
    /** MIME type of the body. */
    content_type: 0x01,
    /** Override placement on a sat other than the first. */
    pointer: 0x02,
    /** Parent inscription id for provenance chains. */
    parent: 0x03,
    /** CBOR-encoded metadata. */
    metadata: 0x05,
    /** Metaprotocol identifier string. */
    metaprotocol: 0x07,
    /** Body encoding hint (`br` for brotli). */
    content_encoding: 0x09,
    /** Delegate inscription id (point to another inscription's body). */
    delegate: 0x0b,
    /** Rune-name commitment for rune etching pre-commit. */
    rune: 0x0d,
    /** Reserved Tag::Note; de facto inscriber-tool watermark. */
    note: 0x0f,
    /** CBOR-encoded gallery items + attributes. */
    properties: 0x11,
    /** Encoding for properties (`br` for brotli). */
    property_encoding: 0x13,
};
/**
 * Maximum bytes per tapscript push. Bitcoin consensus + standardness
 * caps each push at 520 bytes; the encoder slices the body across
 * pushes accordingly. ordpool-parser's `getNextInscriptionMark` walks
 * the same chunk boundaries on the decode side.
 */
const MAX_PUSH_BYTES = 520;
/**
 * Encodes a tag as a script item. Tags 1–16 use the OP_1..OP_16
 * opcodes (single byte, no push prefix); tag 17+ become a 1-byte
 * data push.
 *
 * scure's `Script` codec recognises opcodes by their STRING name
 * (`'OP_1'`, `'CHECKSIG'`, etc.), not by numeric value. Numeric
 * values get interpreted as data pushes. So we hand back the
 * literal opcode name string for 1–16.
 */
function tagAsScriptItem(tag) {
    if (tag <= 0)
        throw new Error(`Tag must be positive; got ${tag}`);
    if (tag <= 16) {
        return `OP_${tag}`;
    }
    return new Uint8Array([tag]);
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
function buildInscriptionEnvelope(args) {
    if (args.revealPubkeyXonly.length !== 32) {
        throw new Error(`revealPubkeyXonly must be 32 bytes; got ${args.revealPubkeyXonly.length}`);
    }
    const items = [];
    // Spending condition: <pubkey> OP_CHECKSIG. The reveal's signature
    // checks against this; everything after is inert data.
    items.push(args.revealPubkeyXonly);
    items.push('CHECKSIG');
    // Envelope opening: OP_FALSE OP_IF "ord".
    items.push('OP_0');
    items.push('IF');
    items.push(ORD_MARKER);
    // content_type comes first by convention (matches every inscriber
    // we've seen on-chain). ord doesn't require any tag order, but
    // keeping content_type first makes hex-grepping the envelope
    // boundary easier.
    if (args.contentType !== undefined) {
        items.push(tagAsScriptItem(exports.ORD_TAGS.content_type));
        items.push(new TextEncoder().encode(args.contentType));
    }
    // Other fields in the order the caller supplied.
    for (const field of args.fields ?? []) {
        items.push(tagAsScriptItem(field.tag));
        items.push(field.value);
    }
    // OP_0 separator: marks the boundary between fields and body.
    // ord's parser uses this as the body start sentinel.
    items.push('OP_0');
    // Body chunks: 520 bytes max per push.
    for (let i = 0; i < args.body.length; i += MAX_PUSH_BYTES) {
        items.push(args.body.subarray(i, i + MAX_PUSH_BYTES));
    }
    // Envelope close.
    items.push('ENDIF');
    return btc_signer_1.Script.encode(items);
}
//# sourceMappingURL=inscription-envelope.js.map