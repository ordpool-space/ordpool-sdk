/**
 * @jest-environment node
 *
 * The wasm brotli ENCODER — the Chrome/Edge fallback path (Blink lacks
 * native `CompressionStream('brotli')`). In the browser the consumer passes
 * a hosted `.wasm` URL; here we init from the package's own `.wasm` BYTES
 * (Node), which the vendored glue's `init()` also accepts.
 *
 * Immutable-data safety bar: the wasm is the reference Rust brotli, and we
 * cross-check every output against TWO independent decoders — `node:zlib`
 * (Google's C brotli) and `ordpool-parser`'s pure-JS `brotliDecode` — so a
 * body it produces is provably standard brotli that ord + the parser
 * recover byte-exact.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { brotliDecode } from 'ordpool-parser';

import { hex } from '@scure/base';

import { brotliModeForContentType, compressBrotliWasm } from './brotli-wasm-encoder';

const enc = (s: string) => new TextEncoder().encode(s);
const WASM = readFileSync(join(__dirname, '../../wasm/brotli_wasm_bg.wasm'));

// ordpool-parser's brotliDecode works on Int8Array; wrap the round-trip.
function parserBrotliDecode(bytes: Uint8Array): Uint8Array {
  const out = brotliDecode(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

describe('wasm brotli encoder (Chrome/Edge fallback)', () => {

  it.each<[string, Uint8Array]>([
    ['plain text', enc('Repeated text '.repeat(50))],
    ['svg', enc('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')],
    ['json', enc(JSON.stringify({ p: 'brc-20', op: 'mint', tick: 'ordi', amt: '1000' }))],
    ['html', enc('<html><body>' + 'cube '.repeat(100) + '</body></html>')],
    ['single byte', new Uint8Array([0x42])],
    ['binary (0..255 x4)', new Uint8Array(1024).map((_, i) => i & 0xff)],
    ['empty', new Uint8Array(0)],
  ])('compresses %s → standard brotli both decoders recover byte-exact', async (_label, input) => {
    const out = await compressBrotliWasm(input, WASM);
    // Independent decoder #1: node:zlib (Google C brotli).
    expect(new Uint8Array(brotliDecompressSync(Buffer.from(out)))).toEqual(input);
    // Independent decoder #2: ordpool-parser (pure-JS brotli).
    expect(parserBrotliDecode(out)).toEqual(input);
  });

  it('shrinks compressible text well (dictionary + window win)', async () => {
    const body = enc('tip the maintainer '.repeat(300));
    const out = await compressBrotliWasm(body, WASM);
    expect(out.length).toBeLessThan(body.length);
  });

  it('round-trips a ~350 KB body', async () => {
    const big = enc('the quick brown fox jumps over the lazy dog. '.repeat(8000));
    expect(big.length).toBeGreaterThan(350_000);
    const out = await compressBrotliWasm(big, WASM);
    expect(new Uint8Array(brotliDecompressSync(Buffer.from(out)))).toEqual(big);
  }, 30_000);

  it('returns a plain Uint8Array', async () => {
    const out = await compressBrotliWasm(enc('hi'), WASM);
    expect(out.constructor.name).toBe('Uint8Array');
  });

  it('rejects non-Uint8Array input', async () => {
    await expect(
      compressBrotliWasm('nope' as unknown as Uint8Array, WASM),
    ).rejects.toThrow(/Uint8Array/);
  });
});

describe('wasm glue — bundler-safety guard', () => {
  it('contains no `import.meta` (would break esbuild/webpack + CommonJS)', () => {
    const glue = readFileSync(join(__dirname, 'brotli-wasm-encoder.ts'), 'utf8');
    expect(glue).not.toMatch(/import\.meta/);
  });
});

describe('ord encoder parameters', () => {
  // The first byte of a brotli stream encodes the window (WBITS). ord
  // compresses with lgwin 24, which brotli writes as 0x1f for these inputs;
  // lgwin 22 (the common library default) would be 0x1b. The byte-for-byte
  // comparison against ord itself lives in
  // e2e/regtest/inscribe-compress-parity.spec.ts.
  it('writes lgwin 24 into the stream header, as ord does', async () => {
    const out = await compressBrotliWasm(enc('the quick brown fox jumps over the lazy dog. '.repeat(40)), WASM, 'text');
    expect(out[0]).toBe(0x1f);
  });

  it('the mode reaches the encoder: font and generic differ on the same input', async () => {
    // At quality 11 text and generic encode identically (brotli decides the
    // literal context from the data itself); font changes the distance
    // parameters, so it is the mode that shows up in the bytes.
    const words = 'cat sat block witness envelope ordinal satoshi inscription gallery parent child pointer metadata'.split(' ');
    let text = '';
    for (let i = 0; i < 800; i++) text += words[(i * 7 + (i >> 3)) % words.length] + (i % 11 === 0 ? '.\n' : ' ');
    const body = enc(text);
    const font = await compressBrotliWasm(body, WASM, 'font');
    const generic = await compressBrotliWasm(body, WASM, 'generic');
    expect(hex.encode(font)).not.toBe(hex.encode(generic));
    expect(new Uint8Array(brotliDecompressSync(Buffer.from(font)))).toEqual(body);
    expect(new Uint8Array(brotliDecompressSync(Buffer.from(generic)))).toEqual(body);
  });

  it.each<[string | undefined, string]>([
    ['text/plain;charset=utf-8', 'text'],
    ['text/html;charset=utf-8', 'text'],
    ['image/svg+xml', 'text'],
    ['application/json', 'text'],
    ['font/woff2', 'font'],
    ['font/ttf', 'generic'],
    ['image/png', 'generic'],
    ['application/octet-stream', 'generic'],
    ['text/html; charset=UTF-8', 'text'],
    ['application/x-unknown', 'generic'],
    [undefined, 'generic'],
  ])('mode for %s is %s (ord media.rs table)', (contentType, mode) => {
    expect(brotliModeForContentType(contentType)).toBe(mode);
  });
});
