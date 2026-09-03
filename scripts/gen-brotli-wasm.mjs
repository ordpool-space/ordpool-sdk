/**
 * Vendor the brotli-wasm encoder as bundler-agnostic artifacts.
 *
 * The inscribe UI needs a browser brotli ENCODER for Chrome/Edge, which
 * lack native `CompressionStream('brotli')` (Safari/Firefox/Node have it).
 * `brotli-wasm`'s own entrypoints don't work in a stock bundler build:
 * the `web` variant fetches the `.wasm` via `new URL(..., import.meta.url)`
 * (webpack/esbuild process that token statically; `import.meta` is also
 * invalid in the CommonJS `dist-core` output), and the `bundler` variant
 * needs webpack's `syncWebAssembly` experiment.
 *
 * So we vendor two files from `brotli-wasm@<version>`:
 *   1. `src/inscribe/brotli-wasm-glue.generated.ts` — the wasm-bindgen glue
 *      with the single `import.meta.url` token removed. `init(urlOrBytes)`
 *      still works: pass a URL string and its built-in `load()` does
 *      `fetch` -> `instantiateStreaming` (with an `arrayBuffer()` fallback
 *      for hosts that don't send `application/wasm`).
 *   2. `wasm/brotli_wasm_bg.wasm` — the reference Rust brotli, shipped as a
 *      PACKAGE ASSET (not bundled into JS). Consumers copy it to their own
 *      origin (the frontend's static assets) and pass the URL to `assessCompression`.
 *
 * Regenerate after a `brotli-wasm` bump: `node scripts/gen-brotli-wasm.mjs`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Read package.json directly — brotli-wasm's exports map blocks `require('brotli-wasm/package.json')`.
const pkgVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/brotli-wasm/package.json'), 'utf8'),
).version;
const glueSrc = join(root, 'node_modules/brotli-wasm/pkg.web/brotli_wasm.js');
const wasmSrc = join(root, 'node_modules/brotli-wasm/pkg.web/brotli_wasm_bg.wasm');

// 1) Patch the glue: remove the ONLY bundler-hostile token. We always pass
//    a URL or bytes, so the `input === undefined` default is dead code; we
//    replace it with an explicit throw so `import.meta` is gone entirely.
let glue = readFileSync(glueSrc, 'utf8');
const HOSTILE = "input = new URL('brotli_wasm_bg.wasm', import.meta.url);";
if (!glue.includes(HOSTILE)) {
  throw new Error(`gen-brotli-wasm: expected token not found (brotli-wasm glue shape changed?): ${HOSTILE}`);
}
glue = glue.replace(
  HOSTILE,
  "throw new Error('brotli-wasm-glue: init() requires a wasm URL or bytes');",
);
if (/import\.meta/.test(glue)) {
  throw new Error('gen-brotli-wasm: import.meta still present after patch');
}

const header = `/* eslint-disable */
// @ts-nocheck
/**
 * AUTO-GENERATED — DO NOT EDIT. Regenerate via \`node scripts/gen-brotli-wasm.mjs\`.
 *
 * Vendored wasm-bindgen glue from brotli-wasm@${pkgVersion} (pkg.web), with its
 * module-relative wasm-URL default removed so it bundles in any tool
 * (esbuild, webpack, …). \`init(urlOrBytes)\`: pass the URL of a hosted
 * \`brotli_wasm_bg.wasm\` (or its bytes in Node).
 */
`;
const glueOut = join(root, 'src/inscribe/brotli-wasm-glue.generated.ts');
writeFileSync(glueOut, header + glue);

// 2) Copy the wasm as a package asset.
mkdirSync(join(root, 'wasm'), { recursive: true });
const wasm = readFileSync(wasmSrc);
writeFileSync(join(root, 'wasm/brotli_wasm_bg.wasm'), wasm);

console.log(`vendored brotli-wasm@${pkgVersion}:`);
console.log(`  ${glueOut}  (${(header.length + glue.length) / 1024 | 0} KB, import.meta removed)`);
console.log(`  wasm/brotli_wasm_bg.wasm  (${(wasm.length / 1024) | 0} KB, shipped as package asset)`);
