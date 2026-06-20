"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAT21_POSTAGE_SATS = void 0;
/**
 * Canonical CAT-21 postage. Every cat-bearing UTXO across the protocol is
 * exactly this value — 546 sats — and every cat-touching tx puts the cat
 * at output 0 with this exact amount.
 *
 * The number is the conservative cross-address-type dust floor (P2TR 330,
 * P2WPKH 294, P2SH 540 — 546 clears them all). Pinning one value across
 * mint, transfer, and offer flows means a cat UTXO is fungible across
 * address types: a cat in P2TR can be moved into P2SH-P2WPKH without
 * re-dust-validating.
 *
 * **No `postageSats` override on any builder.** A future address type with
 * higher dust requirements is a protocol event, not a builder argument.
 * The rule is enforced at exactly one place per builder via this constant
 * plus a runtime assert on cat-input value.
 *
 * See SDK CLAUDE.md "cat UTXO is always 546 sats, FIFO (input 0 → output 0)".
 */
exports.CAT21_POSTAGE_SATS = 546;
//# sourceMappingURL=cat21-postage.js.map