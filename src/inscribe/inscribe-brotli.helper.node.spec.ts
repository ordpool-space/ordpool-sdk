/**
 * @jest-environment node
 *
 * Node-side tests for the isomorphic brotli helpers. The BROWSER-context
 * exercise (the whole point of going isomorphic) lives in the Playwright
 * e2e suite; this pins the Node code path + the pure `assessCompression`
 * logic, and cross-checks that `brotli-wasm` output is standard-conformant
 * by decompressing it with `node:zlib`.
 */

import { describe, expect, it } from '@jest/globals';
import { brotliDecompressSync } from 'node:zlib';

import {
  assessCompression,
  compressBrotli,
  decompressBrotli,
} from './inscribe-brotli.helper';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('compressBrotli / decompressBrotli: byte-exact round-trip', () => {

  it.each<[string, Uint8Array]>([
    ['plain text', enc('Repeated text '.repeat(50))],
    ['svg', enc('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')],
    ['json', enc(JSON.stringify({ p: 'brc-20', op: 'mint', tick: 'ordi', amt: '1000' }))],
    ['html', enc('<html><body>' + 'cube '.repeat(100) + '</body></html>')],
    ['single byte', new Uint8Array([0x42])],
    ['binary (0..255 x4)', new Uint8Array(1024).map((_, i) => i & 0xff)],
  ])('round-trips %s through decompressBrotli', async (_label, input) => {
    const compressed = await compressBrotli(input);
    const back = await decompressBrotli(compressed);
    expect(back).toEqual(input);
  });

  it('round-trips an empty body', async () => {
    const compressed = await compressBrotli(new Uint8Array(0));
    const back = await decompressBrotli(compressed);
    expect(back.length).toBe(0);
  });

  it('round-trips a ~350 KB body byte-for-byte', async () => {
    const big = enc('the quick brown fox jumps over the lazy dog. '.repeat(8000));
    expect(big.length).toBeGreaterThan(350_000);
    const compressed = await compressBrotli(big);
    expect(compressed.length).toBeLessThan(big.length);
    const back = await decompressBrotli(compressed);
    expect(back).toEqual(big);
  }, 30_000);

  it('double-compressing already-brotli data still round-trips (no corruption)', async () => {
    const once = await compressBrotli(enc('hello '.repeat(100)));
    const twice = await compressBrotli(once);
    const back = await decompressBrotli(twice);
    expect(back).toEqual(once);
  });

  it('output is standard-conformant brotli (node:zlib decodes brotli-wasm output)', async () => {
    const input = enc('standard brotli check '.repeat(40));
    const compressed = await compressBrotli(input);
    // If brotli-wasm ever emitted non-standard bytes, ord + the parser
    // would fail to render the inscription. node:zlib is an independent
    // reference decoder.
    expect(new Uint8Array(brotliDecompressSync(Buffer.from(compressed)))).toEqual(input);
  });

  it('returns a plain Uint8Array, not a wasm-glue subtype', async () => {
    const out = await compressBrotli(enc('hello'));
    expect(ArrayBuffer.isView(out)).toBe(true);
    expect(out.constructor.name).toBe('Uint8Array');
  });

  it('rejects non-Uint8Array inputs with a clear error', async () => {
    await expect(compressBrotli('not bytes' as unknown as Uint8Array)).rejects.toThrow(/Uint8Array/);
    await expect(decompressBrotli(42 as unknown as Uint8Array)).rejects.toThrow(/Uint8Array/);
  });
});

describe('assessCompression', () => {

  it('reports worthIt for compressible text with correct savings + a reusable compressed body', async () => {
    const body = enc('tip the maintainer '.repeat(300));
    const a = await assessCompression(body, 'text/html');
    expect(a.worthIt).toBe(true);
    expect(a.originalSize).toBe(body.length);
    expect(a.compressedSize).toBeLessThan(body.length);
    expect(a.savedBytes).toBe(a.originalSize - a.compressedSize);
    expect(a.savedPercent).toBeCloseTo((a.savedBytes / a.originalSize) * 100, 1);
    // The returned compressed body decompresses back to the original,
    // the caller can inscribe it directly with contentEncoding: 'br'.
    expect(await decompressBrotli(a.compressed)).toEqual(body);
  });

  it('reports NOT worthIt for already-compressed (high-entropy) bytes', async () => {
    // Brotli-compressed data is high-entropy; compressing it again cannot
    // shrink it (framing only grows it), so this is a deterministic
    // incompressible input.
    const body = await compressBrotli(enc('x'.repeat(2000)));
    const a = await assessCompression(body, 'application/octet-stream');
    expect(a.worthIt).toBe(false);
    // Not worth it → caller inscribes the original, so `compressed` is the original.
    expect(a.compressed).toBe(body);
  });

  it.each([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'video/mp4', 'audio/mpeg', 'application/zip', 'application/gzip',
    'application/x-brotli', 'font/woff2',
  ])('short-circuits already-compressed type %s WITHOUT running brotli', async (contentType) => {
    // A body that WOULD compress well if brotli ran, proving the skip is
    // by content-type, not by content. `compressed` is the SAME object
    // (reference equality) → no compression happened.
    const body = enc('A'.repeat(5000));
    const a = await assessCompression(body, contentType);
    expect(a.worthIt).toBe(false);
    expect(a.savedBytes).toBe(0);
    expect(a.savedPercent).toBe(0);
    expect(a.compressedSize).toBe(body.length);
    expect(a.compressed).toBe(body); // same reference: brotli never invoked
  });

  it('is case- and parameter-insensitive on the content type', async () => {
    const body = enc('A'.repeat(5000));
    const a = await assessCompression(body, 'IMAGE/PNG; charset=binary');
    expect(a.worthIt).toBe(false);
    expect(a.compressed).toBe(body);
  });

  it('honours a custom minSavedPercent threshold (marginal saving → not worth it)', async () => {
    // A body that compresses only a little. Pick a threshold above its
    // actual saving to force worthIt:false, and below it to force true.
    const body = enc(JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ i, v: `x${i}` }))));
    const low = await assessCompression(body, 'application/json', { minSavedPercent: 0 });
    expect(low.worthIt).toBe(low.savedBytes > 0);
    const high = await assessCompression(body, 'application/json', { minSavedPercent: 99 });
    expect(high.worthIt).toBe(false);
    // The compressed bytes were still measured; the decision is what changed.
    expect(high.compressedSize).toBeLessThanOrEqual(high.originalSize);
  });

  it('treats an unknown content type as compressible (runs brotli)', async () => {
    const body = enc('cube '.repeat(400));
    const a = await assessCompression(body); // no content type at all
    expect(a.worthIt).toBe(true);
    expect(a.compressed).not.toBe(body); // a fresh compressed array
  });

  it('reports 0% saved for an empty body without dividing by zero', async () => {
    const a = await assessCompression(new Uint8Array(0), 'text/plain');
    expect(a.savedPercent).toBe(0);
    expect(a.worthIt).toBe(false);
  });
});
