/**
 * ord's brotli encoder, as wasm. Produces the bytes `ord wallet inscribe
 * --compress` produces, on every runtime.
 *
 * The wasm is built from `wasm-src/brotli-ord` (`npm run build:brotli-wasm`):
 * the Rust `brotli` crate at the exact version cat21-ord's Cargo.lock pins,
 * called the way ord calls it (`Inscription::compress`: quality 11, lgwin 24,
 * lgblock 24, size_hint = input length, a mode chosen from the content type).
 * Native `CompressionStream('brotli')` is valid brotli too, but it runs with
 * its own window and block settings, so its bytes differ from ord's; this
 * encoder is the one that matches.
 *
 * Loading follows the standard wasm-library pattern (onnxruntime-web,
 * sql.js, ffmpeg.wasm): the CONSUMER hosts `wasm/brotli_wasm_bg.wasm` on its
 * own origin and passes the URL; it is fetched and instantiated on demand,
 * once, cached. The ~1 MB never touches the JS bundle.
 *
 * The wasm has no imports and a plain C ABI (`alloc`, `dealloc`, `compress`,
 * `result_ptr`, `result_free`), so the glue below is the whole binding.
 */

/**
 * Where the brotli wasm is loaded from: a URL string (browser, hosted by the
 * consumer app) or the raw bytes / a `Response` (Node, tests).
 */
export type BrotliWasmSource = string | BufferSource | Response;

/** brotli's encoder modes, which ord picks per content type. */
export type BrotliMode = 'generic' | 'text' | 'font';

/** `BrotliEncoderMode` discriminants the wasm's `compress` takes. */
const MODE_CODE: Record<BrotliMode, number> = { generic: 0, text: 1, font: 2 };

/**
 * ord's content type → brotli mode table (cat21-ord
 * src/inscriptions/media.rs, `Media::TABLE`). ord derives the content type
 * from the file extension and compresses with that row's mode.
 */
const ORD_MODE_BY_CONTENT_TYPE: ReadonlyMap<string, BrotliMode> = new Map<string, BrotliMode>([
  ['application/cbor', 'generic'],
  ['application/json', 'text'],
  ['application/octet-stream', 'generic'],
  ['application/pdf', 'generic'],
  ['application/pgp-signature', 'text'],
  ['application/protobuf', 'generic'],
  ['application/x-bittorrent', 'generic'],
  ['application/x-javascript', 'text'],
  ['application/yaml', 'text'],
  ['audio/flac', 'generic'],
  ['audio/mpeg', 'generic'],
  ['audio/ogg', 'generic'],
  ['audio/ogg;codecs=opus', 'generic'],
  ['audio/wav', 'generic'],
  ['font/otf', 'generic'],
  ['font/ttf', 'generic'],
  ['font/woff', 'generic'],
  ['font/woff2', 'font'],
  ['image/apng', 'generic'],
  ['image/avif', 'generic'],
  ['image/gif', 'generic'],
  ['image/jpeg', 'generic'],
  ['image/jxl', 'generic'],
  ['image/png', 'generic'],
  ['image/svg+xml', 'text'],
  ['image/webp', 'generic'],
  ['model/gltf+json', 'text'],
  ['model/gltf-binary', 'generic'],
  ['model/stl', 'generic'],
  ['text/css', 'text'],
  ['text/html', 'text'],
  ['text/html;charset=utf-8', 'text'],
  ['text/javascript', 'text'],
  ['text/markdown', 'text'],
  ['text/markdown;charset=utf-8', 'text'],
  ['text/plain', 'text'],
  ['text/plain;charset=utf-8', 'text'],
  ['text/x-python', 'text'],
  ['video/mp4', 'generic'],
  ['video/webm', 'generic'],
]);

/**
 * The brotli mode ord uses for `contentType`. An exact row of ord's table
 * wins; otherwise the media type without parameters is looked up, so
 * `text/html; charset=UTF-8` still compresses as text. Anything ord's table
 * does not list gets `'generic'`, brotli's default mode (ord cannot inscribe
 * such a file, so there is no ord output to match).
 */
export function brotliModeForContentType(contentType: string | undefined): BrotliMode {
  if (contentType === undefined) return 'generic';
  const exact = ORD_MODE_BY_CONTENT_TYPE.get(contentType);
  if (exact !== undefined) return exact;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return ORD_MODE_BY_CONTENT_TYPE.get(mediaType) ?? 'generic';
}

interface BrotliExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  compress(ptr: number, len: number, mode: number): number;
  result_ptr(): number;
  result_free(): void;
}

let exportsReady: BrotliExports | undefined;
let readyPromise: Promise<BrotliExports> | undefined;
let readyKey: string | undefined;

function sourceKey(source: BrotliWasmSource): string {
  return typeof source === 'string' ? source : '<inline>';
}

async function instantiate(source: BrotliWasmSource): Promise<BrotliExports> {
  let instance: WebAssembly.Instance;
  const isResponse = typeof Response !== 'undefined' && source instanceof Response;
  if (typeof source === 'string' || isResponse) {
    const response = typeof source === 'string' ? await fetch(source) : source as Response;
    if (!response.ok) {
      throw new Error(`brotli wasm: fetch failed with HTTP ${response.status}`);
    }
    // instantiateStreaming needs `Content-Type: application/wasm`; hosts that
    // send something else fall back to reading the bytes.
    const isWasm = (response.headers.get('Content-Type') ?? '').startsWith('application/wasm');
    if (isWasm && typeof WebAssembly.instantiateStreaming === 'function') {
      instance = (await WebAssembly.instantiateStreaming(response, {})).instance;
    } else {
      instance = (await WebAssembly.instantiate(await response.arrayBuffer(), {})).instance;
    }
  } else {
    instance = (await WebAssembly.instantiate(source as BufferSource, {})).instance;
  }
  return instance.exports as unknown as BrotliExports;
}

/**
 * Instantiate the brotli wasm from `source`, once. Idempotent per source:
 * repeated calls with the same URL reuse the first instantiation. Call it
 * eagerly (e.g. when the inscribe route mounts) to warm the encoder, and
 * before {@link compressBrotliSync}.
 */
export function loadBrotliWasm(source: BrotliWasmSource): Promise<void> {
  const key = sourceKey(source);
  if (!readyPromise || readyKey !== key) {
    readyKey = key;
    exportsReady = undefined;
    const pending = instantiate(source);
    readyPromise = pending;
    pending.then(
      (e) => { if (readyPromise === pending) exportsReady = e; },
      () => { if (readyPromise === pending) { readyPromise = undefined; readyKey = undefined; } },
    );
  }
  return readyPromise.then(() => undefined);
}

/**
 * Compress `bytes` with ord's encoder, synchronously. Needs the wasm loaded
 * first ({@link loadBrotliWasm}); throws otherwise. This is the form a sync
 * builder uses, e.g. to compress inscription properties.
 */
export function compressBrotliSync(bytes: Uint8Array, mode: BrotliMode = 'generic'): Uint8Array {
  if (!ArrayBuffer.isView(bytes)) {
    throw new Error('compressBrotli: bytes must be a Uint8Array');
  }
  const code = MODE_CODE[mode];
  if (code === undefined) {
    throw new Error(`compressBrotli: unknown mode ${String(mode)}`);
  }
  const wasm = exportsReady;
  if (wasm === undefined) {
    throw new Error('compressBrotli: the brotli wasm is not loaded; await loadBrotliWasm(source) first');
  }
  const ptr = wasm.alloc(bytes.length);
  try {
    new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
    const n = wasm.compress(ptr, bytes.length, code);
    if (n < 0) throw new Error('compressBrotli: the encoder failed');
    // Read memory.buffer AFTER the call: compressing can grow the memory,
    // which detaches the previous buffer.
    const out = new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), n).slice();
    wasm.result_free();
    return out;
  } finally {
    wasm.dealloc(ptr, bytes.length);
  }
}

/**
 * Compress `bytes` with ord's encoder, loading `source` on first use
 * (cached). Returns standard brotli, decodable by ord, `ordpool-parser`,
 * `node:zlib` and any brotli decoder.
 */
export async function compressBrotliWasm(
  bytes: Uint8Array,
  source: BrotliWasmSource,
  mode: BrotliMode = 'generic',
): Promise<Uint8Array> {
  if (!ArrayBuffer.isView(bytes)) {
    throw new Error('compressBrotli: bytes must be a Uint8Array');
  }
  await loadBrotliWasm(source);
  return compressBrotliSync(bytes, mode);
}
