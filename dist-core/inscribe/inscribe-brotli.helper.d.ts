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
/**
 * Compress `body` with brotli (quality 11, mode generic) on Node.
 * Throws on non-Node runtimes with a pointer at the browser-side
 * alternative.
 */
export declare function compressBrotli(body: Uint8Array): Uint8Array;
//# sourceMappingURL=inscribe-brotli.helper.d.ts.map