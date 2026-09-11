/**
 * JSON metadata encoded to CBOR exactly as `ord wallet inscribe
 * --json-metadata` does.
 *
 * ord reads the file with `serde_json` built with `preserve_order`, then
 * writes it with `ciborium::into_writer` (cat21-ord src/subcommand/wallet.rs,
 * `parse_metadata`). Three consequences no generic JSON-to-CBOR converter
 * reproduces, and each one is a different byte string:
 *
 *  1. OBJECT KEYS KEEP THEIR ORDER IN THE FILE. Not sorted. So
 *     `{"name":…,"age":…}` stays name-then-age. `JSON.parse` cannot be used:
 *     JavaScript hoists integer-like keys ("1", "2") to the front of any
 *     object regardless of where they were written.
 *
 *  2. A NUMBER'S SPELLING DECIDES ITS TYPE. serde_json (cat21-ord's version,
 *     `de.rs` parse_integer / parse_number): no `.`/`e`/`E` means an integer,
 *     u64 when non-negative, i64 when negative; anything else is an f64.
 *     So `1` and `1.0` encode differently, and `-0` is the float -0.0, not the
 *     integer 0. An integer that overflows its range falls back to f64.
 *
 *  3. FLOATS SHRINK. ciborium-ll writes the smallest float that round-trips
 *     bit for bit: f16, else f32, else f64 (hdr.rs, `Header::Float`).
 *
 * Duplicate keys follow IndexMap: the FIRST position is kept and the LAST
 * value wins, which is what serde_json's map insert does with preserve_order.
 */

import { failInscribe } from './inscribe-errors';

type JsonNode =
  | { k: 'null' }
  | { k: 'bool'; v: boolean }
  | { k: 'u64'; v: bigint }
  | { k: 'i64'; v: bigint }
  | { k: 'f64'; v: number }
  | { k: 'str'; v: string }
  | { k: 'arr'; v: JsonNode[] }
  | { k: 'obj'; v: Array<[string, JsonNode]> };

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): JsonNode {
    this.ws();
    const node = this.value();
    this.ws();
    if (this.i !== this.s.length) this.fail('trailing characters');
    return node;
  }

  private fail(msg: string): never {
    failInscribe(
      'invalid-json-metadata',
      `Invalid JSON metadata at ${this.i}: ${msg}`,
      `This is not valid JSON: ${msg}, at character ${this.i}.`,
      { position: this.i, reason: msg },
    );
  }

  private ws(): void {
    while (this.i < this.s.length && ' \t\n\r'.includes(this.s[this.i])) this.i++;
  }

  private value(): JsonNode {
    const c = this.s[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return { k: 'str', v: this.string() };
    if (c === 't') return this.literal('true', { k: 'bool', v: true });
    if (c === 'f') return this.literal('false', { k: 'bool', v: false });
    if (c === 'n') return this.literal('null', { k: 'null' });
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    return this.fail(`unexpected ${c === undefined ? 'end of input' : `"${c}"`}`);
  }

  private literal(word: string, node: JsonNode): JsonNode {
    if (this.s.slice(this.i, this.i + word.length) !== word) this.fail(`expected ${word}`);
    this.i += word.length;
    return node;
  }

  private object(): JsonNode {
    this.i++; // {
    const entries: Array<[string, JsonNode]> = [];
    const at = new Map<string, number>();
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return { k: 'obj', v: entries }; }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail('expected a string key');
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') this.fail('expected ":"');
      this.i++;
      this.ws();
      const val = this.value();
      const existing = at.get(key);
      if (existing === undefined) {
        at.set(key, entries.length);
        entries.push([key, val]);
      } else {
        entries[existing] = [key, val]; // IndexMap: first position, last value
      }
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === '}') { this.i++; return { k: 'obj', v: entries }; }
      this.fail('expected "," or "}"');
    }
  }

  private array(): JsonNode {
    this.i++; // [
    const items: JsonNode[] = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return { k: 'arr', v: items }; }
    for (;;) {
      this.ws();
      items.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === ']') { this.i++; return { k: 'arr', v: items }; }
      this.fail('expected "," or "]"');
    }
  }

  private string(): string {
    this.i++; // opening quote
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) this.fail('unterminated string');
      const c = this.s[this.i++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.s[this.i++];
        if (e === '"' || e === '\\' || e === '/') out += e;
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'u') out += this.unicodeEscape();
        else this.fail(`bad escape \\${e}`);
      } else {
        if (c.charCodeAt(0) < 0x20) this.fail('control character in string');
        out += c;
      }
    }
  }

  private hex4(): number {
    const h = this.s.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail('bad \\u escape');
    this.i += 4;
    return parseInt(h, 16);
  }

  private unicodeEscape(): string {
    const first = this.hex4();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.s.slice(this.i, this.i + 2) !== '\\u') this.fail('lone leading surrogate');
      this.i += 2;
      const second = this.hex4();
      if (second < 0xdc00 || second > 0xdfff) this.fail('invalid trailing surrogate');
      return String.fromCharCode(first, second);
    }
    if (first >= 0xdc00 && first <= 0xdfff) this.fail('lone trailing surrogate');
    return String.fromCharCode(first);
  }

  private number(): JsonNode {
    const start = this.i;
    const negative = this.s[this.i] === '-';
    if (negative) this.i++;
    if (this.s[this.i] === '0') {
      this.i++;
      if (this.s[this.i] >= '0' && this.s[this.i] <= '9') this.fail('leading zero');
    } else if (this.s[this.i] >= '1' && this.s[this.i] <= '9') {
      while (this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++;
    } else {
      this.fail('bad number');
    }
    const intEnd = this.i;
    let isFloat = false;
    if (this.s[this.i] === '.') {
      isFloat = true;
      this.i++;
      if (!(this.s[this.i] >= '0' && this.s[this.i] <= '9')) this.fail('bad fraction');
      while (this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++;
    }
    if (this.s[this.i] === 'e' || this.s[this.i] === 'E') {
      isFloat = true;
      this.i++;
      if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
      if (!(this.s[this.i] >= '0' && this.s[this.i] <= '9')) this.fail('bad exponent');
      while (this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++;
    }
    const text = this.s.slice(start, this.i);
    if (isFloat) return { k: 'f64', v: Number(text) };

    const magnitude = BigInt(this.s.slice(negative ? start + 1 : start, intEnd));
    if (!negative) {
      return magnitude <= U64_MAX ? { k: 'u64', v: magnitude } : { k: 'f64', v: Number(text) };
    }
    // serde_json: a negative integer that is -0 or does not fit i64 becomes f64.
    const value = -magnitude;
    if (magnitude === 0n || value < I64_MIN) return { k: 'f64', v: -Number(magnitude) };
    return { k: 'i64', v: value };
  }
}

// ---- CBOR, matching ciborium's writer ---------------------------------------

function head(major: number, n: bigint, out: number[]): void {
  const m = major << 5;
  if (n < 24n) out.push(m | Number(n));
  else if (n < 0x100n) out.push(m | 24, Number(n));
  else if (n < 0x10000n) out.push(m | 25, Number(n >> 8n), Number(n & 0xffn));
  else if (n < 0x100000000n) {
    out.push(m | 26);
    for (let s = 24n; s >= 0n; s -= 8n) out.push(Number((n >> s) & 0xffn));
  } else {
    out.push(m | 27);
    for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((n >> s) & 0xffn));
  }
}

/** The f16 bit pattern of `x` when it round-trips exactly, otherwise null. */
function exactF16(x: number): number | null {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const sign = hi >>> 31;
  const exp = (hi >>> 20) & 0x7ff;
  const mantHi = hi & 0xfffff;
  if (exp === 0 && mantHi === 0 && lo === 0) return sign << 15; // ±0
  if (exp === 0 || exp === 0x7ff) return null; // f64 subnormal, inf, NaN
  const e = exp - 1023;
  if (e >= -14 && e <= 15) {
    // Normal f16: 10 mantissa bits; the low 42 of f64's 52 must be zero.
    if (lo !== 0 || (mantHi & 0x3ff) !== 0) return null;
    return (sign << 15) | ((e + 15) << 10) | (mantHi >>> 10);
  }
  if (e >= -24 && e < -14) {
    // Subnormal f16 = k * 2^-24, k < 1024. The 53-bit significand
    // (1<<52 | mant) must have its low (52 - (e + 24)) bits zero.
    const significand = (1n << 52n) | (BigInt(mantHi) << 32n) | BigInt(lo);
    const shift = BigInt(52 - (e + 24));
    if ((significand & ((1n << shift) - 1n)) !== 0n) return null;
    return (sign << 15) | Number(significand >> shift);
  }
  return null;
}

function float(x: number, out: number[]): void {
  const h = exactF16(x);
  if (h !== null) { out.push(0xf9, h >> 8, h & 0xff); return; }
  if (Math.fround(x) === x) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, x);
    out.push(0xfa, ...new Uint8Array(dv.buffer));
    return;
  }
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  out.push(0xfb, ...new Uint8Array(dv.buffer));
}

function encode(node: JsonNode, out: number[]): void {
  switch (node.k) {
    case 'null': out.push(0xf6); return;
    case 'bool': out.push(node.v ? 0xf5 : 0xf4); return;
    case 'u64': head(0, node.v, out); return;
    case 'i64': head(1, -1n - node.v, out); return;
    case 'f64': float(node.v, out); return;
    case 'str': {
      const bytes = new TextEncoder().encode(node.v);
      head(3, BigInt(bytes.length), out);
      out.push(...bytes);
      return;
    }
    case 'arr':
      head(4, BigInt(node.v.length), out);
      for (const item of node.v) encode(item, out);
      return;
    case 'obj':
      head(5, BigInt(node.v.length), out);
      for (const [key, val] of node.v) {
        encode({ k: 'str', v: key }, out);
        encode(val, out);
      }
      return;
  }
}

/**
 * The CBOR ord writes for `--json-metadata <FILE>` whose contents are
 * `jsonText`. Pass the file's TEXT, not a parsed object: parsing first would
 * lose the key order and the number spellings this depends on.
 */
export function encodeJsonMetadata(jsonText: string): Uint8Array {
  const out: number[] = [];
  encode(new Parser(jsonText).parse(), out);
  return Uint8Array.from(out);
}
