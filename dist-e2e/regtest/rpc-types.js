"use strict";
/**
 * Typed readers for the `bitcoin-cli` responses this family's harnesses parse.
 *
 * `rpc()` correctly returns `string`, a raw CLI wrapper. The untyped surface is
 * the line AFTER it: every caller writes `JSON.parse(rpc(...)) as {...}` with
 * its own hand-written shape, or omits the cast and reads `any`. A shape that
 * drifts then fails nothing, because nothing ever typechecked the assumption.
 *
 * Every field below was captured from a live Bitcoin Core v30 regtest node
 * rather than transcribed from the docs, and the interfaces are deliberately
 * PARTIAL: they carry what a harness reads, and an unlisted field is absent
 * from the type rather than guessed at.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=rpc-types.js.map