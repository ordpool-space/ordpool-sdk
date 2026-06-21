"use strict";
/**
 * Brotli compression helper for inscribe bodies.
 *
 * Inscription bytes go on-chain at ~~32 sat/vB during congestion;
 * brotli typically shrinks HTML / JSON / text content by 30-70%, so
 * compressing before inscribing is a direct fee win. ord recognises
 * brotli-encoded bodies via the `content_encoding: br` envelope tag
 * (tag 0x09) — the `compressBrotli` output is paired with
 * `createInscribeTransactions({ contentEncoding: 'br', body })` at
 * the call site.
 *
 * # Environment matrix
 *
 * Brotli encoding is NOT part of the standardised web Compression
 * Streams API (`CompressionStream` accepts `gzip`, `deflate`,
 * `deflate-raw` per the WHATWG spec; `'br'` is not in it). So the
 * approach splits by environment:
 *
 *   - **Node 12+ (this helper)**: uses `zlib.brotliCompressSync`,
 *     synchronous, no dependencies.
 *   - **Browser** consumers must pre-compress before calling
 *     `createInscribeTransactions`. Practical options: a WASM
 *     encoder (e.g. `brotli-wasm` npm), a server-side endpoint,
 *     or already-brotli-encoded source content. The SDK's
 *     `contentEncoding: 'br'` flag only emits the envelope tag;
 *     it does not require this helper to have produced the bytes.
 *
 * Sync API on purpose: keeps the inscribe builder's overall flow
 * sync end-to-end, matching `createInscribeTransactions`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.compressBrotli = compressBrotli;
/**
 * Compress `body` with brotli (quality 11, mode generic) on Node.
 * Throws on non-Node runtimes with a pointer at the browser-side
 * alternative.
 */
function compressBrotli(body) {
    if (!ArrayBuffer.isView(body)) {
        throw new Error('compressBrotli: body must be a Uint8Array');
    }
    let zlib;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        zlib = require('node:zlib');
    }
    catch {
        throw new Error('compressBrotli: node:zlib is not available in this runtime. ' +
            'For browsers, pre-compress with a WASM brotli encoder (e.g. brotli-wasm) ' +
            'and pass the result + `contentEncoding: \'br\'` to createInscribeTransactions.');
    }
    const result = zlib.brotliCompressSync(body);
    // zlib returns a Node Buffer (which is a Uint8Array subclass); copy
    // into a fresh Uint8Array so cross-realm callers don't accidentally
    // depend on Buffer-only methods.
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
}
//# sourceMappingURL=inscribe-brotli.helper.js.map