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

import { compressBrotliWasm } from './brotli-wasm-encoder';

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
    const out = await compressBrotliWasm(input, 11, WASM);
    // Independent decoder #1: node:zlib (Google C brotli).
    expect(new Uint8Array(brotliDecompressSync(Buffer.from(out)))).toEqual(input);
    // Independent decoder #2: ordpool-parser (pure-JS brotli).
    expect(parserBrotliDecode(out)).toEqual(input);
  });

  it('shrinks compressible text well (dictionary + window win)', async () => {
    const body = enc('tip the maintainer '.repeat(300));
    const out = await compressBrotliWasm(body, 11, WASM);
    expect(out.length).toBeLessThan(body.length);
  });

  it('round-trips a ~350 KB body', async () => {
    const big = enc('the quick brown fox jumps over the lazy dog. '.repeat(8000));
    expect(big.length).toBeGreaterThan(350_000);
    const out = await compressBrotliWasm(big, 11, WASM);
    expect(new Uint8Array(brotliDecompressSync(Buffer.from(out)))).toEqual(big);
  }, 30_000);

  it('returns a plain Uint8Array', async () => {
    const out = await compressBrotliWasm(enc('hi'), 11, WASM);
    expect(out.constructor.name).toBe('Uint8Array');
  });

  it('rejects non-Uint8Array input', async () => {
    await expect(
      compressBrotliWasm('nope' as unknown as Uint8Array, 11, WASM),
    ).rejects.toThrow(/Uint8Array/);
  });
});

describe('generated glue — bundler-safety guard', () => {
  it('contains no `import.meta` (would break Angular esbuild/webpack + CommonJS)', () => {
    const glue = readFileSync(join(__dirname, 'brotli-wasm-glue.generated.ts'), 'utf8');
    expect(glue).not.toMatch(/import\.meta/);
  });
});
