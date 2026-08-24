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
export const BIP341_KEYPATH_SIGHASHES: readonly number[] = [0x00, 0x01];

/**
 * Per-input `sighashTypes` whitelist for a Unisat-family `toSignInputs`
 * entry. When the target sighash is SIGHASH_ALL (0x01) AND the input is a
 * Taproot address, whitelist BOTH SIGHASH_DEFAULT (0x00) and ALL (0x01):
 * a Taproot key-path input is commonly encoded as SIGHASH_DEFAULT (0x00)
 * in the PSBT, and the two commit to identical wire bytes (see
 * `BIP341_KEYPATH_SIGHASHES`). Otherwise — a non-Taproot input (P2WPKH /
 * P2SH), or an explicit non-ALL sighash (e.g. offer SINGLE|ANYONECANPAY)
 * — whitelist exactly that value. SIGHASH_DEFAULT (0x00) is a Taproot-only
 * concept, so it must NOT appear in a P2WPKH input's whitelist.
 *
 * `address` is the mainnet-shimmed signing address the wallet validates
 * against; Taproot is detected by the `1p` witness-v1 HRP separator
 * (`bc1p` / `tb1p` / `bcrt1p`). Omit it to widen unconditionally (the
 * single-Taproot-input paths that always pass a Taproot address).
 */
export function keypathSighashWhitelist(sigHash: number, address?: string): number[] {
  const isTaproot = address === undefined || /^(bc|tb|bcrt)1p/.test(address);
  return sigHash === 0x01 && isTaproot ? [...BIP341_KEYPATH_SIGHASHES] : [sigHash];
}
