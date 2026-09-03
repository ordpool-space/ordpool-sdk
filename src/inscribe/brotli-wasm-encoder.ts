/**
 * Browser brotli ENCODER for runtimes without native
 * `CompressionStream('brotli')` — i.e. Chrome/Edge (Blink), which
 * deliberately don't ship the brotli compression dictionary. Safari,
 * Firefox, Node 24.7+ and Deno have native brotli and never load this.
 *
 * The encoder is the reference Rust brotli compiled to wasm, vendored via
 * `scripts/gen-brotli-wasm.mjs` into {@link ./brotli-wasm-glue.generated}
 * (glue with no module-relative wasm URL, so it bundles in any tool) plus
 * `wasm/brotli_wasm_bg.wasm` (shipped as a PACKAGE ASSET, not bundled into
 * JS). Loading follows the standard wasm-library pattern (onnxruntime-web,
 * sql.js, ffmpeg.wasm): the CONSUMER hosts the `.wasm` on its own origin
 * (e.g. the frontend's static assets) and passes the URL; we `fetch` + instantiate on
 * demand, once, cached. So the ~1 MB never touches the JS bundle and is
 * only fetched when a Chrome user actually inscribes compressible content.
 */

import init, { compress as glueCompress } from './brotli-wasm-glue.generated';

/**
 * Where the brotli wasm is loaded from: a URL string (browser — hosted by
 * the consumer app, same-origin `assets`) or the raw bytes / a `Response`
 * (Node, tests). Bytes/Response go straight to `WebAssembly.instantiate`;
 * a string is `fetch`ed with an `application/wasm`-MIME streaming path and
 * an `arrayBuffer()` fallback (both handled inside the vendored glue).
 */
export type BrotliWasmSource = string | BufferSource | Response;

let readyPromise: Promise<void> | undefined;
let readyKey: string | undefined;

function sourceKey(source: BrotliWasmSource): string {
  return typeof source === 'string' ? source : '<inline>';
}

/**
 * Instantiate the brotli wasm from `source`, once. Idempotent per source:
 * repeated calls with the same URL reuse the first instantiation. A
 * consumer can call this eagerly (e.g. when the inscribe route mounts) to
 * warm the encoder before the user hits compress.
 */
export function loadBrotliWasm(source: BrotliWasmSource): Promise<void> {
  const key = sourceKey(source);
  if (!readyPromise || readyKey !== key) {
    readyKey = key;
    readyPromise = Promise.resolve(init(source)).then(() => undefined);
  }
  return readyPromise;
}

/**
 * Compress `bytes` with the wasm brotli encoder at the given `quality`
 * (1..11). `source` is loaded on first use (cached). Returns a plain
 * `Uint8Array` of standard brotli bytes (decodable by ord, `ordpool-parser`,
 * `node:zlib`, and any brotli decoder).
 */
export async function compressBrotliWasm(
  bytes: Uint8Array,
  quality: number,
  source: BrotliWasmSource,
): Promise<Uint8Array> {
  if (!ArrayBuffer.isView(bytes)) {
    throw new Error('compressBrotliWasm: bytes must be a Uint8Array');
  }
  await loadBrotliWasm(source);
  const input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = glueCompress(input, { quality }) as Uint8Array;
  // Normalise to a plain Uint8Array independent of the wasm-glue return subtype.
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
