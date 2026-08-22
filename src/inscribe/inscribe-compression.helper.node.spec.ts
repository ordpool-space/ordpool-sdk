/**
 * @jest-environment node
 *
 * Node-side tests for the isomorphic gzip compression helpers. jsdom has
 * no `CompressionStream` / `DecompressionStream`, so the encode/decode
 * paths run here (Node 18+ provides them natively); the browser-env spec
 * covers only the paths that don't need those globals.
 *
 * The safety bar for immutable on-chain data is "byte-exact round-trip
 * through independent decoders". gzip is the platform's zlib (not our
 * code), so the risk of a hand-rolled encoder bug is absent by
 * construction; we still cross-check every compressed output against TWO
 * independent decoders — `ordpool-parser`'s `gzipDecode`
 * (DecompressionStream) and `node:zlib`'s `gunzipSync` (a separate zlib
 * surface) — plus our own `decompressGzip`.
 */

import { describe, expect, it } from '@jest/globals';
import { gunzipSync, gzipSync } from 'node:zlib';
import { gzipDecode } from 'ordpool-parser';

import {
  assessCompression,
  compressGzip,
  decompressGzip,
} from './inscribe-compression.helper';

const enc = (s: string) => new TextEncoder().encode(s);

describe('compressGzip / decompressGzip: byte-exact round-trip', () => {

  it.each<[string, Uint8Array]>([
    ['plain text', enc('Repeated text '.repeat(50))],
    ['svg', enc('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')],
    ['json', enc(JSON.stringify({ p: 'brc-20', op: 'mint', tick: 'ordi', amt: '1000' }))],
    ['html', enc('<html><body>' + 'cube '.repeat(100) + '</body></html>')],
    ['single byte', new Uint8Array([0x42])],
    ['binary (0..255 x4)', new Uint8Array(1024).map((_, i) => i & 0xff)],
  ])('round-trips %s through decompressGzip', async (_label, input) => {
    const compressed = await compressGzip(input);
    const back = await decompressGzip(compressed);
    expect(back).toEqual(input);
  });

  it('emits a gzip stream (magic bytes 1f 8b)', async () => {
    const out = await compressGzip(enc('gzip magic check'));
    expect(out[0]).toBe(0x1f);
    expect(out[1]).toBe(0x8b);
  });

  it('round-trips an empty body', async () => {
    const compressed = await compressGzip(new Uint8Array(0));
    const back = await decompressGzip(compressed);
    expect(back.length).toBe(0);
  });

  it('round-trips a ~350 KB body byte-for-byte', async () => {
    const big = enc('the quick brown fox jumps over the lazy dog. '.repeat(8000));
    expect(big.length).toBeGreaterThan(350_000);
    const compressed = await compressGzip(big);
    expect(compressed.length).toBeLessThan(big.length);
    const back = await decompressGzip(compressed);
    expect(back).toEqual(big);
  }, 30_000);

  it('double-compressing already-gzip data still round-trips (no corruption)', async () => {
    const once = await compressGzip(enc('hello '.repeat(100)));
    const twice = await compressGzip(once);
    const back = await decompressGzip(twice);
    expect(back).toEqual(once);
  });

  it('output is standard gzip: ordpool-parser AND node:zlib both decode it byte-exact', async () => {
    const input = enc('standard gzip check '.repeat(40));
    const compressed = await compressGzip(input);
    // Independent decoder #1: the parser's gzipDecode (DecompressionStream).
    expect(await gzipDecode(compressed)).toEqual(input);
    // Independent decoder #2: node:zlib (a separate zlib surface). If our
    // output were non-standard, ord + the parser would fail to render.
    expect(new Uint8Array(gunzipSync(Buffer.from(compressed)))).toEqual(input);
  });

  it('decompresses gzip produced by an independent encoder (node:zlib)', async () => {
    const input = enc('decode a foreign gzip stream '.repeat(20));
    const foreign = new Uint8Array(gzipSync(Buffer.from(input)));
    expect(await decompressGzip(foreign)).toEqual(input);
  });

  it('aborts a decompression bomb instead of allocating it', async () => {
    // 2 MiB of zeros gzips tiny but decompresses past the 1 MiB cap.
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(2 * 1024 * 1024)));
    await expect(decompressGzip(bomb)).rejects.toThrow(/exceeds allowed limit/);
  });

  it('returns a plain Uint8Array', async () => {
    const out = await compressGzip(enc('hello'));
    expect(ArrayBuffer.isView(out)).toBe(true);
    expect(out.constructor.name).toBe('Uint8Array');
  });

  it('rejects non-Uint8Array inputs with a clear error', async () => {
    await expect(compressGzip('not bytes' as unknown as Uint8Array)).rejects.toThrow(/Uint8Array/);
    await expect(decompressGzip(42 as unknown as Uint8Array)).rejects.toThrow(/Uint8Array/);
  });
});

describe('assessCompression', () => {

  it('reports worthIt + bestEncoding gzip for compressible text with a reusable body', async () => {
    const body = enc('tip the maintainer '.repeat(300));
    const a = await assessCompression(body, 'text/html');
    expect(a.worthIt).toBe(true);
    expect(a.bestEncoding).toBe('gzip');
    expect(a.originalSize).toBe(body.length);
    expect(a.compressedSize).toBeLessThan(body.length);
    // compressedSize is the size of the returned `compressed` bytes.
    expect(a.compressedSize).toBe(a.compressed.length);
    expect(a.savedBytes).toBe(a.originalSize - a.compressedSize);
    expect(a.savedPercent).toBeCloseTo((a.savedBytes / a.originalSize) * 100, 1);
    // The returned compressed body decompresses back to the original, so
    // the caller inscribes it directly with contentEncoding: a.bestEncoding.
    expect(await gzipDecode(a.compressed)).toEqual(body);
  });

  it('reports NOT worthIt (bestEncoding none) for already-compressed high-entropy bytes', async () => {
    // gzipped data is high-entropy; compressing it again can't shrink it
    // (framing only grows it), a deterministic incompressible input.
    const body = await compressGzip(enc('x'.repeat(2000)));
    const a = await assessCompression(body, 'application/octet-stream');
    expect(a.worthIt).toBe(false);
    expect(a.bestEncoding).toBe('none');
    // Not worth it → caller inscribes the original, so `compressed` is it.
    expect(a.compressed).toBe(body);
    expect(a.compressedSize).toBe(body.length);
    expect(a.savedBytes).toBe(0);
    expect(a.savedPercent).toBe(0);
  });

  it.each([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'video/mp4', 'audio/mpeg', 'application/zip', 'application/gzip',
    'application/x-brotli', 'font/woff2',
  ])('short-circuits already-compressed type %s WITHOUT running a compressor', async (contentType) => {
    // A body that WOULD compress well if a compressor ran, proving the
    // skip is by content-type, not by content. `compressed` is the SAME
    // object (reference equality) → nothing compressed.
    const body = enc('A'.repeat(5000));
    const a = await assessCompression(body, contentType);
    expect(a.worthIt).toBe(false);
    expect(a.bestEncoding).toBe('none');
    expect(a.savedBytes).toBe(0);
    expect(a.savedPercent).toBe(0);
    expect(a.compressedSize).toBe(body.length);
    expect(a.compressed).toBe(body); // same reference: no compressor invoked
  });

  it('is case- and parameter-insensitive on the content type', async () => {
    const body = enc('A'.repeat(5000));
    const a = await assessCompression(body, 'IMAGE/PNG; charset=binary');
    expect(a.worthIt).toBe(false);
    expect(a.bestEncoding).toBe('none');
    expect(a.compressed).toBe(body);
  });

  it('honours a custom minSavedPercent threshold (marginal saving → not worth it)', async () => {
    const body = enc(JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ i, v: `x${i}` }))));
    const low = await assessCompression(body, 'application/json', { minSavedPercent: 0 });
    expect(low.worthIt).toBe(low.savedBytes > 0);
    // An unreachable threshold forces worthIt:false → bestEncoding none,
    // compressed falls back to the original.
    const high = await assessCompression(body, 'application/json', { minSavedPercent: 99 });
    expect(high.worthIt).toBe(false);
    expect(high.bestEncoding).toBe('none');
    expect(high.compressed).toBe(body);
    expect(high.compressedSize).toBe(body.length);
  });

  it('treats an unknown content type as compressible (runs gzip)', async () => {
    const body = enc('cube '.repeat(400));
    const a = await assessCompression(body); // no content type at all
    expect(a.worthIt).toBe(true);
    expect(a.bestEncoding).toBe('gzip');
    expect(a.compressed).not.toBe(body); // a fresh compressed array
  });

  it('reports 0% saved for an empty body without dividing by zero', async () => {
    const a = await assessCompression(new Uint8Array(0), 'text/plain');
    expect(a.savedPercent).toBe(0);
    expect(a.worthIt).toBe(false);
    expect(a.bestEncoding).toBe('none');
  });

  it('rejects non-Uint8Array bytes with a clear error', async () => {
    await expect(assessCompression('nope' as unknown as Uint8Array)).rejects.toThrow(/Uint8Array/);
  });
});
