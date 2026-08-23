/**
 * Isomorphic inscription-body compression (browser + Node).
 *
 * Inscription bytes go on-chain at real sat/vB; compressing HTML / JSON /
 * SVG / text before inscribing is a direct fee win. ord recognises a
 * compressed body via the `content_encoding` envelope tag (0x09) and
 * serves it back with a matching HTTP `Content-Encoding` header, so the
 * viewing browser transparently decompresses it (see cat21-ord
 * `src/subcommand/server/r.rs`). Browsers always send `Accept-Encoding:
 * gzip, deflate, br`, so both `gzip` and `br` bodies render everywhere
 * ordinals do; brotli typically lands ~15-20% smaller than gzip on
 * text/SVG/JSON.
 *
 * # Codecs: native first, wasm brotli only where forced
 *
 * - **gzip** — native `CompressionStream('gzip')` everywhere (Node 18+,
 *   all modern browsers). The universal baseline.
 * - **brotli, native** — `CompressionStream('brotli')` where the runtime
 *   has it: Safari 18.4+, Firefox 147+, Node 24.7+, Deno 2.7+ (brotli was
 *   added to the WHATWG Compression Standard in 2026). Zero dependency,
 *   no fetch.
 * - **brotli, wasm fallback** — Chrome/Edge (Blink) deliberately don't
 *   ship the brotli compression dictionary, so there is no native encoder
 *   there. For those runtimes {@link assessCompression} uses the reference
 *   Rust brotli compiled to wasm (see {@link ./brotli-wasm-encoder}), but
 *   ONLY when the caller passes `brotliWasmUrl`. The `.wasm` is a hosted
 *   PACKAGE ASSET the consumer serves from its own origin and is fetched
 *   on demand — it never bloats the JS bundle. Omit the URL and Chrome
 *   simply falls back to gzip.
 *
 * Immutable-data safety: every encoder here is the platform's zlib or the
 * reference Rust brotli — never hand-rolled — so an encoder bug can't
 * corrupt an inscription. Decoding lives in `ordpool-parser`
 * (`brotliDecode` / native `DecompressionStream`).
 *
 * # Async on purpose
 *
 * The Compression Streams API is a stream API, so the primitives return
 * Promises. Callers `await` them; the inscribe builder stays sync because
 * compression happens at the call site BEFORE `createInscribeTransactions`
 * (see {@link assessCompression}).
 *
 * # Reuse beyond inscribe (cubes)
 *
 * {@link assessCompression} is deliberately generic (arbitrary bytes + a
 * content-type). cubes-frontend's cube HTML is highly compressible text,
 * so cubes can adopt it for its cube inscriptions with no inscribe-specific
 * coupling. This file ships in `dist-core`, so both browser consumers
 * import it from `ordpool-sdk/core`.
 */

import { compressBrotliWasm } from './brotli-wasm-encoder';

/**
 * Body encodings the inscribe builder can tag on-chain (`content_encoding`,
 * tag 0x09). `'gzip'` is what {@link assessCompression} produces here;
 * `'br'` remains valid for a consumer that brings its own brotli bytes
 * (the builder emits whichever tag; only the decoder needs to exist, and
 * it lives in `ordpool-parser`). Exported as a runtime tuple so the
 * inscribe operation-gate can validate untrusted input against it.
 */
export const INSCRIPTION_CONTENT_ENCODINGS = ['br', 'gzip'] as const;

export type InscriptionContentEncoding = typeof INSCRIPTION_CONTENT_ENCODINGS[number];

/**
 * Upper bound on a single decompression, mirroring `ordpool-parser`'s
 * `MAX_DECOMPRESSED_SIZE`. {@link decompressGzip} aborts the stream the
 * moment the running output crosses this, so a crafted gzip payload can't
 * force an unbounded allocation. 1 MiB comfortably covers any inscription
 * body we build (the parser uses the same ceiling on the render path).
 */
const MAX_DECOMPRESSED_SIZE = 1 * 1024 * 1024;

/**
 * The native Compression Streams formats we drive. `'brotli'` was added to
 * the WHATWG Compression Standard in 2026 and is live in Safari 18.4+ /
 * Firefox 147+ / Node 24.7+ / Deno 2.7+.
 */
type StreamCompressionFormat = 'gzip' | 'brotli';

async function compressViaCompressionStream(
  body: Uint8Array,
  format: StreamCompressionFormat,
): Promise<Uint8Array> {
  if (!ArrayBuffer.isView(body)) {
    throw new Error('compress: body must be a Uint8Array');
  }
  if (typeof CompressionStream === 'undefined') {
    throw new Error(
      `${format} compression is not supported in this environment. For Node.js, upgrade to version 18 or higher.`,
    );
  }
  const input = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  // `as BufferSource`: TS 5.7+ typed-array workaround (Uint8Array's backing
  // buffer is `ArrayBufferLike`, which BlobPart won't accept). `as unknown as
  // CompressionFormat`: lib.dom.d.ts still types the enum as gzip/deflate
  // only, predating 'brotli' in the 2026 spec.
  const stream = new Blob([input as BufferSource])
    .stream()
    .pipeThrough(new CompressionStream(format as unknown as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Compress `body` with gzip via the native Compression Streams API. Works
 * in the browser AND Node. Returns a fresh `Uint8Array` (gzip stream:
 * magic `1f 8b`).
 */
export async function compressGzip(body: Uint8Array): Promise<Uint8Array> {
  return compressViaCompressionStream(body, 'gzip');
}

/**
 * Whether the runtime has a native `CompressionStream('brotli')` encoder:
 * true on Safari 18.4+, Firefox 147+, Node 24.7+, Deno 2.7+; false on
 * Chrome/Edge (Blink), which deliberately don't ship the brotli compression
 * dictionary. Construction throws synchronously for an unsupported format,
 * so this is a cheap sync feature test.
 */
export function nativeBrotliAvailable(): boolean {
  if (typeof CompressionStream === 'undefined') return false;
  try {
    new CompressionStream('brotli' as unknown as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decompress a gzip `body` via the native Compression Streams API. The
 * inverse of {@link compressGzip}; used to verify a `content_encoding:
 * 'gzip'` body recovers its original bytes.
 *
 * Mirrors `ordpool-parser`'s `gzipDecode` decompression-bomb guard: the
 * running output is capped at {@link MAX_DECOMPRESSED_SIZE} and the stream
 * is cancelled the instant it would be exceeded. Unlike the parser's
 * render-path variant (which returns an error string as bytes so rendering
 * never throws), this verify-path variant THROWS on a bomb or on invalid
 * data, because a caller checking a round-trip wants the failure surfaced.
 */
export async function decompressGzip(body: Uint8Array): Promise<Uint8Array> {
  if (!ArrayBuffer.isView(body)) {
    throw new Error('decompressGzip: body must be a Uint8Array');
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'gzip decoding is not supported in this environment. For Node.js, upgrade to version 18 or higher.',
    );
  }
  const input = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const ds = new DecompressionStream('gzip');

  // Swallow the per-call writer rejections so cancelling the reader on a
  // bomb doesn't surface as an unhandled ABORT_ERR from the in-flight writer.
  const writer = ds.writable.getWriter();
  writer.write(input as BufferSource).catch(() => { /* aborted on bomb cancel */ });
  writer.close().catch(() => { /* aborted on bomb cancel */ });

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalSize += value.byteLength;
      if (totalSize > MAX_DECOMPRESSED_SIZE) {
        await reader.cancel();
        throw new Error('Decompressed size exceeds allowed limit');
      }
    }
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** brotli quality on the wasm path (max; matches ord's encoders). */
const BROTLI_WASM_QUALITY = 11;

interface Codec {
  encoding: Exclude<InscriptionContentEncoding, never>;
  compress: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/**
 * The compressors {@link assessCompression} tries, chosen per call:
 *   - `gzip` always (native Compression Streams; universal).
 *   - `br` via native `CompressionStream('brotli')` when the runtime has it
 *     (Safari / Firefox / Node) — zero dependency, no fetch.
 *   - else `br` via the wasm encoder IF the caller passed `brotliWasmUrl`
 *     (Chrome / Edge path: fetch + instantiate the hosted wasm on demand).
 * assessCompression runs them all and keeps the smallest output; ties go to
 * the earlier entry (gzip), so it stays first.
 */
function buildCodecs(options: AssessCompressionOptions): Codec[] {
  const codecs: Codec[] = [{ encoding: 'gzip', compress: compressGzip }];
  if (nativeBrotliAvailable()) {
    codecs.push({ encoding: 'br', compress: (b) => compressViaCompressionStream(b, 'brotli') });
  } else if (options.brotliWasmUrl) {
    const url = options.brotliWasmUrl;
    codecs.push({ encoding: 'br', compress: (b) => compressBrotliWasm(b, BROTLI_WASM_QUALITY, url) });
  }
  return codecs;
}

/**
 * Content types whose payload is already compressed, so re-compressing
 * almost never helps and often adds bytes. {@link assessCompression}
 * short-circuits these WITHOUT running any compressor. Compared
 * case-insensitively against the media type with any `; parameters`
 * stripped.
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
 * compressed. {@link assessCompression} NEVER decides silently: it hands
 * back the numbers + the winning bytes and the caller/UI picks yes/no.
 */
export interface CompressionAssessment {
  /**
   * `true` when compressing meaningfully shrinks the body (smaller by at
   * least the minimum margin). The caller inscribes `compressed` +
   * `contentEncoding: bestEncoding` only when this is `true`.
   */
  worthIt: boolean;
  /**
   * The winning codec's `content_encoding` tag value when `worthIt`, else
   * `'none'` (inscribe `compressed` — the original bytes — uncompressed,
   * no `content_encoding` tag). `'br'` is produced where a brotli encoder
   * is available: native `CompressionStream('brotli')`, or the wasm encoder
   * when the caller passes `brotliWasmUrl`.
   */
  bestEncoding: 'none' | InscriptionContentEncoding;
  /** Byte length of the original body. */
  originalSize: number;
  /** Byte length of `compressed` (equals `originalSize` when `bestEncoding === 'none'`). */
  compressedSize: number;
  /** `originalSize - compressedSize` (0 when not worth it / short-circuited). */
  savedBytes: number;
  /** `savedBytes / originalSize * 100`, rounded to 2 decimals (0 when `originalSize` is 0). */
  savedPercent: number;
  /**
   * When `worthIt`, the compressed bytes to inscribe (so the caller never
   * compresses twice). When not worth it, the ORIGINAL bytes (the body to
   * inscribe uncompressed).
   */
  compressed: Uint8Array;
}

export interface AssessCompressionOptions {
  /**
   * Minimum saving (percent of the original) required to report
   * `worthIt: true`. Default 5%. Rationale: the `content_encoding`
   * envelope tag itself costs a few bytes on-chain and gzip adds a small
   * framing overhead, so a sub-few-percent "saving" can be a net loss once
   * the tag is counted; 5% clears that comfortably for any non-trivial
   * body. A consumer with different economics can override it.
   */
  minSavedPercent?: number;
  /**
   * URL of a hosted `brotli_wasm_bg.wasm` (shipped in this package under
   * `wasm/`; the consumer app copies it to its own origin and passes that
   * URL). ONLY used on runtimes WITHOUT native `CompressionStream('brotli')`
   * — i.e. Chrome/Edge — to fetch + instantiate the wasm brotli encoder on
   * demand (once, cached). Omit it and Chrome/Edge simply fall back to gzip;
   * Safari/Firefox/Node use native brotli and never touch this.
   */
  brotliWasmUrl?: string;
}

/**
 * Assess whether inscribing `bytes` compressed is worth it, trying every
 * available codec (gzip, plus brotli where an encoder exists) and returning
 * the smallest winner. Pure
 * assessment: emits NO envelope tag, makes NO inscribe-specific
 * assumptions, and returns everything the caller needs to decide. Generic
 * enough for cubes-frontend to call on arbitrary cube HTML.
 *
 * Behaviour:
 *   - Known already-compressed `contentType` (image/*, video, zip, woff2,
 *     …) → short-circuits to `worthIt: false`, `bestEncoding: 'none'`
 *     WITHOUT running any compressor (`compressed` = the original bytes).
 *   - Otherwise compresses once per codec, keeps the smallest output, and
 *     sets `worthIt = savedBytes > 0 && savedPercent >= minSavedPercent`.
 *     The `savedBytes > 0` term also guards the "compressed output larger
 *     than the original → not worth it" case. On a size tie the earlier
 *     codec wins (gzip; see {@link buildCodecs}). The winning bytes are
 *     returned so the caller reuses them (never compresses twice).
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
      bestEncoding: 'none',
      originalSize,
      compressedSize: originalSize,
      savedBytes: 0,
      savedPercent: 0,
      compressed: bytes,
    };
  }

  // Run every available codec; keep the smallest output. Codec order breaks
  // ties (gzip first).
  const candidates = await Promise.all(
    buildCodecs(options).map(async (codec) => ({ encoding: codec.encoding, out: await codec.compress(bytes) })),
  );
  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.out.length < best.out.length) best = candidate;
  }

  const wouldSaveBytes = originalSize - best.out.length;
  const wouldSavePercent = originalSize === 0
    ? 0
    : Math.round((wouldSaveBytes / originalSize) * 10000) / 100;
  const worthIt = wouldSaveBytes > 0 && wouldSavePercent >= minSavedPercent;

  if (!worthIt) {
    // Not worth it → caller inscribes the original, so `compressed` is the
    // original and every derived figure reflects that (0 saved).
    return {
      worthIt: false,
      bestEncoding: 'none',
      originalSize,
      compressedSize: originalSize,
      savedBytes: 0,
      savedPercent: 0,
      compressed: bytes,
    };
  }

  return {
    worthIt: true,
    bestEncoding: best.encoding,
    originalSize,
    compressedSize: best.out.length,
    savedBytes: wouldSaveBytes,
    savedPercent: wouldSavePercent,
    compressed: best.out,
  };
}
