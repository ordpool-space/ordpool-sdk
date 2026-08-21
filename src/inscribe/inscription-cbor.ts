/**
 * Deterministic CBOR encoder for inscription metadata + properties.
 *
 * ## Why this lives in the SDK, not in ordpool-parser
 *
 * ordpool-parser owns the CBOR *decoder* (`lib/cbor.ts`, `CBOR.decode`)
 * and is a zero-dependency *decode* library — nothing there ever
 * encodes CBOR. The inscribe pipeline is the only place in the whole
 * ecosystem that *builds* inscriptions, so it is the only CBOR
 * *producer*. That mirrors the existing split exactly: the envelope
 * encoder (`buildInscriptionEnvelope`) is described in its own module
 * doc as "the inverse of ordpool-parser's InscriptionParserService"
 * and it lives here in the SDK, not in the parser. This CBOR encoder
 * is the same shape of thing — the inverse of `CBOR.decode` — so it
 * belongs next to the envelope encoder it feeds.
 *
 * The correctness oracle is still the parser: every value this encoder
 * produces round-trips through ordpool-parser's `CBOR.decode` in the
 * spec, so encoder and decoder stay pinned as inverses.
 *
 * ## Deterministic = canonical (RFC 8949 §4.2)
 *
 * "Deterministic" here means: the same logical value always produces
 * the same bytes. That property matters for a signing library —
 * identical metadata must yield an identical inscription envelope,
 * hence an identical commit address, so a retried inscribe is
 * idempotent and reproducible.
 *
 * The encoder implements RFC 8949 §4.2.1 core rules:
 *   - integers use the shortest encoding that fits;
 *   - all lengths are definite (never indefinite/streaming);
 *   - map keys are sorted in bytewise lexicographic order of their
 *     own deterministic encodings.
 *
 * Non-integer numbers are emitted as float64 (§4.2.2's shortest-float
 * preference is NOT implemented — metadata rarely carries floats, and
 * float64 is already deterministic: the same double always encodes to
 * the same 8 bytes). Everything else is fully canonical.
 *
 * ## Supported types
 *
 *   number   → integer (major 0/1) if a safe integer, else float64
 *   bigint   → integer (major 0/1), range [-(2^64), 2^64 - 1]
 *   string   → UTF-8 text string (major 3)
 *   Uint8Array / any ArrayBuffer view → byte string (major 2)
 *   boolean  → 0xf5 (true) / 0xf4 (false)
 *   null     → 0xf6
 *   Array    → array (major 4)
 *   Map      → map (major 5) with number | bigint | string keys
 *   object   → map (major 5) with string keys (own enumerable)
 *
 * `undefined`, functions, and symbols throw — CBOR has no faithful,
 * unambiguous encoding for them and silently dropping them would make
 * the output non-deterministic w.r.t. the input.
 */

/** Max bytes CBOR's native integer heads can express (u64). */
const U64_MAX = (1n << 64n) - 1n;
/** Most-negative CBOR native integer: major type 1 stores -(n+1), n up to u64_max. */
const NEG_MIN = -(1n << 64n);

/**
 * Encode a value as canonical (deterministic) CBOR.
 * Throws on unsupported inputs rather than emitting lossy bytes.
 */
export function encodeCborDeterministic(value: unknown): Uint8Array {
  const out: number[] = [];
  encodeItem(value, out);
  return Uint8Array.from(out);
}

/** Emit a CBOR head: major type in the top 3 bits, argument `n`. */
function writeHead(major: number, n: bigint, out: number[]): void {
  const mt = major << 5;
  if (n < 24n) {
    out.push(mt | Number(n));
  } else if (n < 0x100n) {
    out.push(mt | 24, Number(n));
  } else if (n < 0x10000n) {
    out.push(mt | 25, Number(n >> 8n) & 0xff, Number(n) & 0xff);
  } else if (n < 0x100000000n) {
    out.push(mt | 26);
    for (let shift = 24n; shift >= 0n; shift -= 8n) out.push(Number((n >> shift) & 0xffn));
  } else {
    // 8-byte argument (u64). Callers guarantee n <= U64_MAX.
    out.push(mt | 27);
    for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((n >> shift) & 0xffn));
  }
}

/** Encode a signed integer (number or bigint) as major type 0 / 1. */
function encodeInteger(value: bigint, out: number[]): void {
  if (value >= 0n) {
    if (value > U64_MAX) {
      throw new Error(`Integer ${value} exceeds CBOR u64 range; pre-encode as a byte string for bignums.`);
    }
    writeHead(0, value, out);
  } else {
    if (value < NEG_MIN) {
      throw new Error(`Integer ${value} below CBOR negative range; pre-encode as a byte string for bignums.`);
    }
    // Major type 1 stores -(n + 1); recover n = -value - 1.
    writeHead(1, -value - 1n, out);
  }
}

function encodeItem(value: unknown, out: number[]): void {
  if (value === null) {
    out.push(0xf6);
    return;
  }
  if (value === true) {
    out.push(0xf5);
    return;
  }
  if (value === false) {
    out.push(0xf4);
    return;
  }

  switch (typeof value) {
    case 'number': {
      if (Number.isInteger(value) && Number.isSafeInteger(value)) {
        encodeInteger(BigInt(value), out);
        return;
      }
      if (!Number.isFinite(value)) {
        throw new Error(`Cannot CBOR-encode non-finite number ${value}.`);
      }
      // Non-integer (or unsafe-integer) → float64. Deterministic: the
      // same double always serialises to the same 8 bytes.
      out.push(0xfb);
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, value, false); // big-endian per CBOR
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < 8; i++) out.push(bytes[i]);
      return;
    }

    case 'bigint':
      encodeInteger(value, out);
      return;

    case 'string': {
      const utf8 = new TextEncoder().encode(value);
      writeHead(3, BigInt(utf8.length), out);
      for (let i = 0; i < utf8.length; i++) out.push(utf8[i]);
      return;
    }

    case 'object': {
      if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(
          (value as ArrayBufferView).buffer,
          (value as ArrayBufferView).byteOffset,
          (value as ArrayBufferView).byteLength,
        );
        writeHead(2, BigInt(bytes.length), out);
        for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
        return;
      }

      if (Array.isArray(value)) {
        writeHead(4, BigInt(value.length), out);
        for (const item of value) encodeItem(item, out);
        return;
      }

      if (value instanceof Map) {
        encodeMapEntries([...value.entries()], out);
        return;
      }

      // Plain object → string-keyed map.
      const entries = Object.entries(value as Record<string, unknown>);
      encodeMapEntries(entries, out);
      return;
    }

    default:
      // undefined, function, symbol.
      throw new Error(`Cannot CBOR-encode value of type ${typeof value}.`);
  }
}

/**
 * Encode map entries with RFC 8949 §4.2.1 canonical key ordering:
 * each key is deterministically encoded, then entries are sorted by
 * the bytewise lexicographic order of those key-encodings.
 */
function encodeMapEntries(entries: Array<[unknown, unknown]>, out: number[]): void {
  const encoded = entries.map(([k, v]) => {
    const keyBytes: number[] = [];
    encodeKey(k, keyBytes);
    const valBytes: number[] = [];
    encodeItem(v, valBytes);
    return { keyBytes, valBytes };
  });

  encoded.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));

  writeHead(5, BigInt(encoded.length), out);
  for (const { keyBytes, valBytes } of encoded) {
    out.push(...keyBytes);
    out.push(...valBytes);
  }
}

/**
 * Map keys are restricted to the CBOR key types the parser's decoder
 * reads back cleanly: text strings and integers. `Object.entries`
 * always hands us string keys; a `Map` may carry number / bigint keys
 * (ord's properties format uses integer keys). A string key that is a
 * canonical non-negative integer (`"0"`, `"1"`, …) coming from a plain
 * object stays a text-string key — we do NOT silently reinterpret it
 * as an integer key, because that would change the map's meaning.
 * Use a `Map` with real numeric keys when integer keys are intended.
 */
function encodeKey(key: unknown, out: number[]): void {
  if (typeof key === 'string') {
    const utf8 = new TextEncoder().encode(key);
    writeHead(3, BigInt(utf8.length), out);
    for (let i = 0; i < utf8.length; i++) out.push(utf8[i]);
    return;
  }
  if (typeof key === 'number' && Number.isSafeInteger(key)) {
    encodeInteger(BigInt(key), out);
    return;
  }
  if (typeof key === 'bigint') {
    encodeInteger(key, out);
    return;
  }
  throw new Error(`Unsupported CBOR map key type: ${typeof key} (${String(key)}). Use string or integer keys.`);
}

/** Bytewise lexicographic comparison; shorter is smaller when a prefix. */
function compareBytes(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
