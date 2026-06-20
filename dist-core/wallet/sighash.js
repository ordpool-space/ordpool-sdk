"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BIP341_KEYPATH_SIGHASHES = void 0;
/**
 * Sighash whitelist for Taproot key-path inputs.
 *
 * Per BIP-341, SIGHASH_DEFAULT (0x00) and SIGHASH_ALL (0x01) commit
 * to the same set on key-path spends — every input, every output.
 * The only difference is the witness encoding: DEFAULT emits a
 * 64-byte Schnorr signature (no flag byte), ALL emits 65 bytes
 * (R|S + 0x01). The on-chain coverage is identical.
 *
 * Any SDK signer that opts into a per-input `sighashTypes` whitelist
 * (Alby's bitcoinjs-lib policy check, Unisat-shaped `toSignInputs`,
 * Binance's same shape) accepts BOTH shapes for Taproot inputs.
 * Whitelisting only `[0x01]` would force the SDK to emit explicit
 * SIGHASH_ALL on Taproot inputs, which some wallet signers reject
 * because their default bitcoinjs whitelist excludes it.
 *
 * Non-Taproot inputs (P2PKH / P2SH-P2WPKH / P2WPKH) always carry
 * explicit `sighashType: SIGHASH_ALL` in the PSBT and are enforced
 * by the post-build asserts in `cat21-mint.helper.ts` /
 * `cat21-transfer.helper.ts` / `cat21-offer.helper.ts`. This
 * constant is exclusively for Taproot-capable signing paths.
 */
exports.BIP341_KEYPATH_SIGHASHES = [0x00, 0x01];
//# sourceMappingURL=sighash.js.map