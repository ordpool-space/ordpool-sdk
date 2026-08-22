/**
 * Browser-environment (jsdom) exercise of the compression helper.
 *
 * jsdom does NOT implement `CompressionStream` / `DecompressionStream`
 * (they are `undefined` there), so the gzip encode/decode paths cannot run
 * here — they are covered in `inscribe-compression.helper.node.spec.ts`
 * (real globals under Node) and end-to-end on chain in
 * `e2e/regtest/inscribe-features-roundtrip.spec.ts`. Real-browser support
 * of the native Compression Streams API is a platform guarantee (Chrome
 * 80+, Safari 16.4+, Firefox 113+), and the browser bundle staying clean
 * (no dangling node-only import after dropping brotli-wasm) is enforced by
 * the esbuild `platform: 'browser'` harness build in CI.
 *
 * This file pins the paths that DON'T need those globals: the
 * already-compressed short-circuit (compressor never invoked) and input
 * validation. It runs ONLY under the jsdom (browser) config; the node
 * config skips `.browser.spec.ts`.
 */

import { describe, expect, it } from '@jest/globals';

import { assessCompression, compressGzip } from './inscribe-compression.helper';

const enc = (s: string) => new TextEncoder().encode(s);

describe('compression helper in a browser env (jsdom)', () => {

  it('confirms we are in a browser-like environment (window/document present)', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });

  it('short-circuits already-compressed types WITHOUT needing a compressor', async () => {
    // The short-circuit path is codec-independent, so it returns a correct
    // answer even in an env (jsdom) that has no CompressionStream.
    const body = enc('A'.repeat(5000));
    const a = await assessCompression(body, 'image/png');
    expect(a.worthIt).toBe(false);
    expect(a.bestEncoding).toBe('none');
    expect(a.compressed).toBe(body); // same reference: no compressor ran
    expect(a.compressedSize).toBe(body.length);
  });

  it('rejects non-Uint8Array bytes with a clear error (before any codec)', async () => {
    await expect(assessCompression('nope' as unknown as Uint8Array)).rejects.toThrow(/Uint8Array/);
  });

  it('surfaces a clear, actionable error when the runtime lacks CompressionStream', async () => {
    // jsdom has no CompressionStream; the guard must name the requirement
    // rather than throw an opaque ReferenceError. (A real browser has the
    // API, so this path only fires in jsdom / very old runtimes.)
    expect(typeof CompressionStream).toBe('undefined');
    await expect(compressGzip(enc('x'.repeat(100)))).rejects.toThrow(/not supported in this environment/);
  });
});
