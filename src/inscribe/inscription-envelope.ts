import { OP, Script } from '@scure/btc-signer';

// scure-btc-signer 1.2.x's ScriptOP union is internal: a string
// opcode name like `'CHECKSIG'`, a Uint8Array data push, or a
// numeric pushdata-int. `Script.encode` resolves opcode names from
// the OP enum and frames data pushes automatically. Pushing a raw
// number gets interpreted as data, NOT as an opcode — that's the
// trap to avoid when building this script by hand.
type ScureScriptItem = keyof typeof OP | Uint8Array | number;

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
export const ORD_TAGS = {
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
  /** Body encoding hint (e.g. `gzip`, or `br` for brotli). */
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
} as const;

export type OrdTag = typeof ORD_TAGS[keyof typeof ORD_TAGS];

/**
 * Maximum bytes per tapscript push. Bitcoin consensus + standardness
 * caps each push at 520 bytes; the encoder slices the body across
 * pushes accordingly. ordpool-parser's `getNextInscriptionMark` walks
 * the same chunk boundaries on the decode side.
 */
const MAX_PUSH_BYTES = 520;

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
  /**
   * How each tag number is pushed into the tapscript. `false`
   * (default) uses a 1-byte DATA push (`OP_PUSHBYTES_1 <tag>`) —
   * byte-for-byte what ord's own wallet emits, so the inscription is
   * charm-free. `true` uses the pushnum opcode `OP_1..OP_16` for tags
   * 1–16 — 1 byte smaller per tag, but ord flags any pushnum inside an
   * envelope as `Curse::Pushnum` and stamps the `vindicated` charm
   * (post-jubilee). Everything else about the inscription is identical:
   * same content, same tracking, same parent/child provenance, and on
   * mainnet the same non-negative number. Purely a push-encoding choice.
   */
  minimalTagPush?: boolean;
}

/**
 * Encodes a tag as a script item. The push form is the ONLY difference
 * between an ord-standard inscription and a `vindicated`-charmed one; it's
 * purely how the tag number lands in the script:
 *
 *   - `minimal === false` (default): a 1-byte DATA push,
 *     `OP_PUSHBYTES_1 <tag>` (e.g. `01 01`). Byte-for-byte what ord emits
 *     (`Tag::append` → `push_slice(self.bytes())`), so the inscription is
 *     blessed / charm-free. scure does NOT minimal-encode a single byte
 *     back to a pushnum — `Script.encode([Uint8Array([1])])` is `01 01`,
 *     not `51` — so `Uint8Array([tag])` yields ord's exact bytes.
 *   - `minimal === true`: the pushnum opcode `OP_1..OP_16` (e.g. `51`) for
 *     tags 1–16 — 1 byte smaller, but ord flags any pushnum inside an
 *     envelope as `Curse::Pushnum` → the inscription carries the
 *     `vindicated` charm (post-jubilee). Everything else about the
 *     inscription is identical. Tags > 16 have no pushnum opcode and always
 *     data-push regardless of `minimal`.
 */
function tagAsScriptItem(tag: number, minimal: boolean): keyof typeof OP | Uint8Array {
  if (tag <= 0) throw new Error(`Tag must be positive; got ${tag}`);
  if (tag > 255) throw new Error(`Tag must fit in one byte; got ${tag}`);
  if (minimal && tag <= 16) {
    return `OP_${tag}` as keyof typeof OP;
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
 *     <tag>                              (1-byte data push, ord-identical)
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
/**
 * Guard a single envelope push against the 520-byte standardness cap.
 * The remediation depends on the tag: only metadata (0x05) and
 * properties (0x11) are read back by concatenating repeated same-tag
 * chunks, so only those can be split with `chunkFieldValue`. Every
 * other tag (content_type, metaprotocol, note, parent, delegate, rune,
 * …) is read from its FIRST field only, so splitting silently truncates
 * it; those values simply must fit in one push.
 */
function assertPushWithinCap(tag: number, length: number): void {
  if (length <= MAX_PUSH_BYTES) return;
  const chunkable = tag === ORD_TAGS.metadata || tag === ORD_TAGS.properties;
  const advice = chunkable
    ? 'Split into repeated same-tag fields with chunkFieldValue.'
    : 'This tag is read from its first field only and cannot be chunked; the value must fit in one push.';
  throw new Error(
    `envelope field value for tag ${tag} is ${length} bytes; max ${MAX_PUSH_BYTES} per push. ${advice}`,
  );
}

export function buildInscriptionEnvelope(args: BuildInscriptionEnvelopeArgs): Uint8Array {
  if (args.revealPubkeyXonly.length !== 32) {
    throw new Error(`revealPubkeyXonly must be 32 bytes; got ${args.revealPubkeyXonly.length}`);
  }

  const items: ScureScriptItem[] = [];
  const minimalTagPush = args.minimalTagPush ?? false;

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
    const contentTypeBytes = new TextEncoder().encode(args.contentType);
    // Same 520-byte standardness cap as every other push (below). A
    // content_type over the cap is absurd for a real MIME type, but the
    // guard keeps every single push in this envelope uniformly checked
    // rather than leaving one silent hole.
    assertPushWithinCap(ORD_TAGS.content_type, contentTypeBytes.length);
    items.push(tagAsScriptItem(ORD_TAGS.content_type, minimalTagPush));
    items.push(contentTypeBytes);
  }

  // Other fields in the order the caller supplied.
  for (const field of args.fields ?? []) {
    // Each field value is ONE push. Bitcoin standardness caps a push at
    // 520 bytes, and ord's decoder reads each field as a single
    // pushdata, so a value above the cap can't be a valid single field.
    // Fail loud here rather than emit a non-standard, non-relayable push.
    assertPushWithinCap(field.tag, field.value.length);
    items.push(tagAsScriptItem(field.tag, minimalTagPush));
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

  return Script.encode(items as ScureScriptItem[] as never);
}

/**
 * Encode an inscription id (`<txid>i<index>`) into the byte form ord
 * expects wherever an inscription id appears in an envelope value:
 * tag 0x03 (`parent`), tag 0x0b (`delegate`), and gallery items:
 *
 *   [ 32 bytes: reversed txid ][ 0..4 bytes: little-endian index, trailing zeros trimmed ]
 *
 * Zero-index gets no trailing bytes; index 256 encodes as `[0x00, 0x01]`;
 * index 0xFFFFFFFF (u32 max) encodes as `[0xFF, 0xFF, 0xFF, 0xFF]`.
 *
 * Byte-for-byte inverse of `ordpool-parser`'s `extractInscriptionId`,
 * which is what ordpool renders parents / delegates from. If the
 * round-trip doesn't match, the parser drops the id silently (ord's
 * `filter_map` semantics), so the caller MUST hand us a canonical id
 * form.
 */
export function encodeInscriptionId(inscriptionId: string): Uint8Array {
  const m = inscriptionId.match(/^([0-9a-f]{64})i(\d+)$/);
  if (!m) {
    throw new Error(
      `Invalid inscription id "${inscriptionId}"; expected 64 lowercase hex + "i" + non-negative integer.`,
    );
  }
  const txidHex = m[1];
  const indexStr = m[2];
  if (indexStr.length > 1 && indexStr.startsWith('0')) {
    throw new Error(`Invalid inscription index "${indexStr}"; canonical form has no leading zeros.`);
  }
  const index = Number(indexStr);
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`Inscription index out of u32 range: ${indexStr}`);
  }

  const txidBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    txidBytes[i] = parseInt(txidHex.substr(i * 2, 2), 16);
  }
  txidBytes.reverse();

  if (index === 0) {
    return txidBytes;
  }
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, true);
  let end = 4;
  while (end > 0 && indexBytes[end - 1] === 0) end--;
  const out = new Uint8Array(32 + end);
  out.set(txidBytes);
  out.set(indexBytes.subarray(0, end), 32);
  return out;
}

/**
 * Backwards-compatible alias. `parent` (tag 0x03) and `delegate`
 * (tag 0x0b) share the same inscription-id byte form, so both go
 * through `encodeInscriptionId`. Kept exported because consumers +
 * specs already import this name.
 */
export const encodeParentInscriptionId = encodeInscriptionId;

/**
 * Encode a pointer sat-offset (tag 0x02) as minimal little-endian
 * bytes: the u64 offset with trailing zero bytes trimmed. Offset 0
 * encodes as an empty push (ord reads a missing/empty value as 0);
 * 255 → `[0xff]`; 256 → `[0x00, 0x01]`.
 *
 * Inverse of `ordpool-parser`'s `extractPointer`, which little-endian-
 * decodes the value. The pointer names the sat position (in the
 * concatenated outputs) the inscription is assigned to; only the
 * builder knows whether that offset is reachable given the reveal's
 * output topology, so range-vs-topology validation lives at the
 * synthesis layer, not here.
 */
export function encodePointerValue(offset: number): Uint8Array {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`pointer must be a non-negative integer; got ${offset}`);
  }
  if (!Number.isSafeInteger(offset)) {
    throw new Error(`pointer ${offset} exceeds the safe-integer range`);
  }
  return minimalLeBytes(BigInt(offset));
}

/**
 * Encode a rune-name commitment (tag 0x0d) as minimal little-endian
 * bytes: the rune's u128 value with trailing zero bytes trimmed.
 * Value 0 encodes as an empty push. Rejects negatives and anything
 * above u128 max.
 *
 * ord's rune etching reads this back as the u128 commitment (see
 * `ordpool-parser` `knownFields.rune`); the etching tx must later
 * spend this inscription's UTXO. A pre-computed byte value can still
 * be passed through the generic `envelopeFields` escape hatch.
 */
export function encodeRuneCommitment(value: bigint): Uint8Array {
  if (typeof value !== 'bigint') {
    throw new Error('rune commitment must be a bigint');
  }
  if (value < 0n) {
    throw new Error(`rune commitment must be non-negative; got ${value}`);
  }
  const U128_MAX = (1n << 128n) - 1n;
  if (value > U128_MAX) {
    throw new Error(`rune commitment ${value} exceeds u128 range`);
  }
  return minimalLeBytes(value);
}

/** Little-endian bytes of a non-negative bigint, trailing zeros trimmed. */
function minimalLeBytes(value: bigint): Uint8Array {
  if (value === 0n) {
    return new Uint8Array(0);
  }
  const bytes: number[] = [];
  let v = value;
  while (v > 0n) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return Uint8Array.from(bytes);
}

/**
 * Split a field value into one-or-more `{ tag, value }` entries so no
 * single push exceeds the 520-byte standardness cap. ord's decoder
 * concatenates all same-tag chunks before decoding (metadata tag 0x05,
 * properties tag 0x11), so a large CBOR blob is carried as several
 * repeated-tag fields.
 *
 * A zero-length value yields a single empty-value field (callers that
 * reject empty payloads gate that upstream).
 */
export function chunkFieldValue(tag: OrdTag, value: Uint8Array): OrdEnvelopeField[] {
  if (value.length === 0) {
    return [{ tag, value }];
  }
  const fields: OrdEnvelopeField[] = [];
  for (let i = 0; i < value.length; i += MAX_PUSH_BYTES) {
    fields.push({ tag, value: value.subarray(i, i + MAX_PUSH_BYTES) });
  }
  return fields;
}
