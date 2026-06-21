/**
 * @jest-environment node
 *
 * `compressBrotli` smoke test on Node. The function wraps the
 * web-streams `CompressionStream` API, which Node 18+ exposes
 * globally. We verify the output is genuine brotli bytes (decompress
 * roundtrip through `zlib.brotliDecompressSync`) and that the
 * compressed size is meaningfully smaller than the input for a
 * compressible body.
 */

import { describe, expect, it } from '@jest/globals';
import { brotliDecompressSync } from 'node:zlib';

import { compressBrotli } from './inscribe-brotli.helper';

describe('compressBrotli', () => {
  it('produces brotli bytes that decompress back to the original body', () => {
    const original = new TextEncoder().encode(
      'Repeated text repeated text repeated text repeated text repeated text repeated text.',
    );
    const compressed = compressBrotli(original);
    const decompressed = brotliDecompressSync(compressed);
    expect(decompressed).toEqual(Buffer.from(original));
  });

  it('shrinks highly-repetitive content meaningfully (~10x or better)', () => {
    const repetitive = new TextEncoder().encode('A'.repeat(10_000));
    const compressed = compressBrotli(repetitive);
    expect(compressed.length).toBeLessThan(repetitive.length / 10);
  });

  it('returns a Uint8Array (not a Node Buffer subclass leaking through)', () => {
    const out = compressBrotli(new TextEncoder().encode('hello'));
    // Cross-realm safety: structural check rather than instanceof.
    expect(ArrayBuffer.isView(out)).toBe(true);
    expect(out.constructor.name).toBe('Uint8Array');
  });

  it('rejects non-Uint8Array inputs with a clear error', () => {
    expect(() => compressBrotli('not bytes' as unknown as Uint8Array)).toThrow(/Uint8Array/);
  });
});
