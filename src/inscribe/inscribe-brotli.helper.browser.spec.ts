/**
 * Browser-environment (jsdom) exercise of the brotli compressor.
 *
 * The whole point of taking the `brotli-wasm` dependency is that browsers
 * have no native brotli. This spec runs `compressBrotli` /
 * `decompressBrotli` / `assessCompression` under the jsdom test
 * environment (browser globals present: `window`, `document`,
 * `TextEncoder`, `fetch`) to prove the wasm compressor works outside Node.
 *
 * Honest scope: jsdom loads brotli-wasm's node wasm variant (via a
 * `moduleNameMapper` in `jest.config.browser.js`) because jsdom can't
 * instantiate the webpack syncWebAssembly `browser` variant. The wasm
 * bytes are identical across variants; only the load glue differs. Real
 * browser bundlers (ordpool's webpack, cubes' Angular) resolve and
 * instantiate the `browser` variant natively. The on-chain integration
 * proof lives in `e2e/regtest/inscribe-features-roundtrip.spec.ts`.
 *
 * This file runs ONLY under the jsdom (browser) config; the node config
 * skips `.browser.spec.ts`, and the exhaustive Node coverage lives in
 * `inscribe-brotli.helper.node.spec.ts`.
 */

import { describe, expect, it } from '@jest/globals';

import {
  assessCompression,
  compressBrotli,
  decompressBrotli,
} from './inscribe-brotli.helper';

const enc = (s: string) => new TextEncoder().encode(s);

describe('brotli compressor in a browser env (jsdom)', () => {

  it('confirms we are in a browser-like environment (window/document present)', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });

  it('compresses + decompresses back to the original under jsdom', async () => {
    const body = enc('<html><body>' + 'cube '.repeat(200) + '</body></html>');
    const compressed = await compressBrotli(body);
    expect(compressed.length).toBeLessThan(body.length);
    const back = await decompressBrotli(compressed);
    expect(back).toEqual(body);
  });

  it('assessCompression reports worthIt for compressible HTML with a reusable body', async () => {
    const body = enc('tip the maintainer '.repeat(300));
    const a = await assessCompression(body, 'text/html');
    expect(a.worthIt).toBe(true);
    expect(a.compressedSize).toBeLessThan(a.originalSize);
    expect(await decompressBrotli(a.compressed)).toEqual(body);
  });

  it('assessCompression short-circuits already-compressed types without invoking brotli', async () => {
    const body = enc('A'.repeat(5000));
    const a = await assessCompression(body, 'image/png');
    expect(a.worthIt).toBe(false);
    expect(a.compressed).toBe(body); // same reference: brotli never ran
  });
});
