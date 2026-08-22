/**
 * Isomorphic brotli compression for inscription bodies (browser + Node).
 *
 * Inscription bytes go on-chain at ~32 sat/vB during congestion; brotli
 * typically shrinks HTML / JSON / text by 30-70%, so compressing before
 * inscribing is a direct fee win. ord recognises brotli-encoded bodies
 * via the `content_encoding: br` envelope tag (0x09); the `compressBrotli`
 * output is paired with `createInscribeTransactions({ contentEncoding:
 * 'br', body })` at the call site.
 *
 * # Why a dependency, and why `brotli-wasm`
 *
 * Brotli is NOT part of the web Compression Streams API (`CompressionStream`
 * only does gzip / deflate), so a browser cannot produce a `content_encoding:
 * 'br'` body on its own. The two browser consumers that need this
 * (ordpool `/inscribe` and cubes-frontend) therefore require a real brotli
 * encoder that runs in the browser. The zero-dependency rule is relaxed
 * here for that reason (maintainer-approved).
 *
 * We take exactly one runtime dependency: **`brotli-wasm` (pinned 3.0.1)**.
 *   - **Correctness first.** These bytes land on Bitcoin permanently. A
 *     hand-rolled or pure-JS encoder with a rare edge-case bug would
 *     corrupt an inscription forever. `brotli-wasm` is the reference Rust
 *     brotli compiled to WebAssembly, so its output is standard-conformant
 *     by construction. Verified: `node:zlib.brotliDecompressSync` AND
 *     `ordpool-parser`'s inline decoder both decode `brotli-wasm` output.
 *   - **Single code path.** One library, one async API, Node + browser
 *     (its package `exports` resolve `index.node.js` / `index.browser.js`
 *     automatically). No `typeof window` branching.
 *   - **Clean supply chain.** Zero transitive dependencies, no install
 *     scripts (no `postinstall`/`prepare`), Apache-2.0, integrity-pinned
 *     in `package-lock.json`.
 *   - **Size cost.** The package is ~3.2 MB unpacked (multiple target
 *     variants); a browser bundle ships one wasm variant (~hundreds of KB),
 *     loaded once and cached. That is a one-time bundle cost, not a
 *     per-inscription cost, and is dwarfed by the on-chain fee an
 *     image-or-HTML inscriber already pays. Consumers should lazy-load the
 *     inscribe route so the wasm isn't in the initial bundle.
 *
 * # Async on purpose
 *
 * WebAssembly instantiation is async, so `compressBrotli` /
 * `decompressBrotli` return Promises (the module is initialised once and
 * cached). Callers `await` them; the inscribe builder itself stays sync
 * because compression happens at the call site BEFORE
 * `createInscribeTransactions` (see `assessCompression`).
 *
 * # Reuse beyond inscribe (cubes)
 *
 * `assessCompression` is deliberately generic (takes arbitrary bytes +
 * a content-type). cubes-frontend's cube HTML (`t='id1|id2|…'` +
 * `<script src=/content/RENDERER>`) is highly compressible text, so cubes
 * can adopt `assessCompression` for its cube inscriptions without any
 * inscribe-specific coupling. This file ships in `dist-core`, so both
 * browser consumers import it from `ordpool-sdk/core`.
 */

/** The subset of the brotli-wasm module surface we use. */
interface BrotliWasm {
  compress(input: Uint8Array, options?: { quality?: number }): Uint8Array;
  decompress(input: Uint8Array): Uint8Array;
}

/**
 * brotli-wasm's default export is a Promise that resolves to the module
 * once the wasm is instantiated. Cache the resolved module so the wasm is
 * initialised at most once per process/page.
 */
let brotliModulePromise: Promise<BrotliWasm> | undefined;

async function getBrotli(): Promise<BrotliWasm> {
  if (!brotliModulePromise) {
    brotliModulePromise = import('brotli-wasm').then(
      (mod) => (mod.default ?? mod) as unknown as BrotliWasm,
    );
  }
  return brotliModulePromise;
}

/**
 * Brotli quality 11 (maximum). Matches the previous `node:zlib` default
 * and the compression ratio ord's own encoders produce. Inscribing is a
 * one-time action, so the extra CPU of q11 over q9 is worth the smaller
 * on-chain body.
 */
const BROTLI_QUALITY = 11;

/**
 * Compress `body` with brotli (quality 11). Works in the browser AND Node
 * via `brotli-wasm`. Returns a fresh `Uint8Array`.
 */
export async function compressBrotli(body: Uint8Array): Promise<Uint8Array> {
  if (!ArrayBuffer.isView(body)) {
    throw new Error('compressBrotli: body must be a Uint8Array');
  }
  const brotli = await getBrotli();
  const input = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const out = brotli.compress(input, { quality: BROTLI_QUALITY });
  // Normalise to a plain Uint8Array so cross-realm callers don't depend on
  // any wasm-glue return subtype.
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Decompress brotli `body`. The inverse of `compressBrotli`; used by tests
 * and by any consumer that wants to verify a `content_encoding: 'br'` body
 * recovers its original bytes. `ordpool-parser` already decompresses `br`
 * bodies on read (`getContent()` / `getDataUri()`); this is the SDK-side
 * primitive for the same operation.
 */
export async function decompressBrotli(body: Uint8Array): Promise<Uint8Array> {
  if (!ArrayBuffer.isView(body)) {
    throw new Error('decompressBrotli: body must be a Uint8Array');
  }
  const brotli = await getBrotli();
  const input = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const out = brotli.decompress(input);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Content types whose payload is already compressed, so brotli almost
 * never helps and often adds bytes. `assessCompression` short-circuits
 * these WITHOUT running brotli. Compared case-insensitively against the
 * media type with any `; parameters` stripped.
 */
const ALREADY_COMPRESSED_TYPES: ReadonlySet<string> = new Set([
  // Raster images (all entropy-coded / already compressed).
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  // Video / audio containers.
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/aac',
  'audio/webm',
  // Archives / already-compressed streams.
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-brotli',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-bzip2',
  // Compressed font container (woff2 is brotli-compressed already; woff is
  // zlib-compressed).
  'font/woff2',
  'font/woff',
]);

/** Default minimum saving (percent) below which compression isn't worth it. */
const DEFAULT_MIN_SAVED_PERCENT = 5;

/**
 * The facts a consumer needs to decide whether to inscribe a body
 * brotli-compressed. `assessCompression` NEVER decides silently: it hands
 * back the numbers + the compressed bytes and the caller/UI picks yes/no.
 */
export interface CompressionAssessment {
  /**
   * `true` when compressing meaningfully shrinks the body (smaller by at
   * least the minimum margin). The caller inscribes `compressed` +
   * `contentEncoding: 'br'` only when this is `true`.
   */
  worthIt: boolean;
  /** Byte length of the original body. */
  originalSize: number;
  /** Byte length of the brotli output (equals `originalSize` for short-circuited types). */
  compressedSize: number;
  /** `originalSize - compressedSize` (0 when not worth it / short-circuited). */
  savedBytes: number;
  /** `savedBytes / originalSize * 100`, rounded to 2 decimals (0 when `originalSize` is 0). */
  savedPercent: number;
  /**
   * When `worthIt`, the brotli-compressed bytes to inscribe (so the caller
   * never compresses twice). When not worth it, the ORIGINAL bytes (the
   * body to inscribe uncompressed).
   */
  compressed: Uint8Array;
}

export interface AssessCompressionOptions {
  /**
   * Minimum saving (percent of the original) required to report
   * `worthIt: true`. Default 5%. Rationale: the `content_encoding: 'br'`
   * envelope tag itself costs ~4 bytes on-chain and brotli adds a small
   * framing overhead, so a sub-few-percent "saving" can be a net loss once
   * the tag is counted; 5% clears that comfortably for any non-trivial
   * body. A consumer with different economics can override it.
   */
  minSavedPercent?: number;
}

/**
 * Assess whether inscribing `bytes` brotli-compressed is worth it. Pure
 * assessment: emits NO envelope tag, makes NO inscribe-specific
 * assumptions, and returns everything the caller needs to decide. Generic
 * enough for cubes-frontend to call on arbitrary cube HTML.
 *
 * Behaviour:
 *   - Known already-compressed `contentType` (image/*, video, zip, woff2,
 *     …) → short-circuits to `worthIt: false` WITHOUT running brotli
 *     (`compressed` = the original bytes, 0% saved).
 *   - Otherwise compresses once, compares, and sets
 *     `worthIt = savedBytes > 0 && savedPercent >= minSavedPercent`. The
 *     `savedBytes > 0` term is also the "brotli output larger than the
 *     original → not worth it" guard. The `compressed` bytes are returned
 *     so the caller reuses them (never compresses twice).
 */
export async function assessCompression(
  bytes: Uint8Array,
  contentType?: string,
  options: AssessCompressionOptions = {},
): Promise<CompressionAssessment> {
  if (!ArrayBuffer.isView(bytes)) {
    throw new Error('assessCompression: bytes must be a Uint8Array');
  }
  const minSavedPercent = options.minSavedPercent ?? DEFAULT_MIN_SAVED_PERCENT;
  const originalSize = bytes.length;

  const mediaType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (ALREADY_COMPRESSED_TYPES.has(mediaType)) {
    return {
      worthIt: false,
      originalSize,
      compressedSize: originalSize,
      savedBytes: 0,
      savedPercent: 0,
      compressed: bytes,
    };
  }

  const compressed = await compressBrotli(bytes);
  const compressedSize = compressed.length;
  const savedBytes = originalSize - compressedSize;
  const savedPercent = originalSize === 0
    ? 0
    : Math.round((savedBytes / originalSize) * 10000) / 100;
  const worthIt = savedBytes > 0 && savedPercent >= minSavedPercent;

  return {
    worthIt,
    originalSize,
    compressedSize,
    savedBytes,
    savedPercent,
    // Reuse the compressed bytes when worth it; otherwise the caller
    // inscribes the original, so hand that back to avoid a larger body.
    compressed: worthIt ? compressed : bytes,
  };
}
