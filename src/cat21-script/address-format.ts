/**
 * Address-format detection and Bitcoin dust-floor helpers.
 *
 * Used across the CAT-21 pipeline (mint, transfer, offer) AND by
 * cat21.space's per-address-type dust math in `createTransaction`.
 * Lives in `cat21-script/` because every consumer that constructs
 * scure scripts also needs to detect the address shape it's working
 * with.
 *
 * No CAT-21-specific semantics — pure Bitcoin address-format logic.
 */

/**
 * Conservative dust-floor (in sats) per address type. P2SH could
 * be Nested SegWit (540) or full-witness-script wrap; we return 546
 * uniformly — the 6-sat slack is negligible. P2PK is not supported.
 *
 *   P2PKH               → 546
 *   P2SH (any wrap)     → 546
 *   P2WPKH              → 294
 *   P2TR                → 330
 *
 * References:
 *   https://help.magiceden.io/en/articles/8665399-navigating-bitcoin-dust-understanding-limits-and-safeguarding-your-transactions-on-magic-eden
 *   https://en.bitcoin.it/wiki/List_of_address_prefixes
 *   https://unchained.com/blog/bitcoin-address-types-compared/
 *
 * @throws if the address prefix isn't recognised.
 */
export function getMinimumUtxoSize(address: string): number {
  // Mainnet addresses
  if (address.startsWith('1')) return 546; // P2PKH
  if (address.startsWith('3')) return 546; // P2SH??? (including Nested SegWit, conservatively treated)
  if (address.startsWith('bc1q')) return 294; // P2WPKH
  if (address.startsWith('bc1p')) return 330; // P2TR

  // Testnet addresses
  if (address.startsWith('m') || address.startsWith('n')) return 546; // P2PKH testnet
  if (address.startsWith('2')) return 546; // P2SH??? (including Nested SegWit, conservatively treated) testnet
  if (address.startsWith('tb1q')) return 294; // P2WPKH testnet
  if (address.startsWith('tb1p')) return 330; // P2TR testnet

  // Regtest addresses (same key/script prefixes as testnet, but
  // bech32 HRP is `bcrt`)
  if (address.startsWith('bcrt1q')) return 294; // P2WPKH regtest
  if (address.startsWith('bcrt1p')) return 330; // P2TR regtest

  throw new Error('Unsupported address type');
}

/**
 * Address format from prefix. `P2SH???` because P2SH covers multiple
 * wrap shapes (P2SH-P2WPKH, P2SH-P2WSH); resolving the inner shape
 * needs the redeem script. P2PK not supported.
 *
 *   '1' / 'm' / 'n'                   → P2PKH
 *   '3' / '2'                         → P2SH???
 *   'bc1q' / 'tb1q' / 'bcrt1q'        → P2WPKH
 *   'bc1p' / 'tb1p' / 'bcrt1p'        → P2TR
 *
 * @throws if the prefix isn't recognised.
 */
export function getAddressFormat(address: string): 'P2WPKH' | 'P2SH???' | 'P2TR' | 'P2PKH' {
  // "Legacy" Pay-to-Public-Key-Hash
  if (address.startsWith('1') || address.startsWith('m') || address.startsWith('n')) {
    return 'P2PKH';
  }

  // Uncertain P2SH format, maybe Nested Segwit
  if (address.startsWith('3') || address.startsWith('2')) {
    return 'P2SH???';
  }

  // Native Seqwit, bcrt1q comes before tb1q because every bcrt1q
  // also starts with `b`; with the ordering inverted, mainnet `bc1q`
  // would match first and regtest addresses would be mis-categorized
  // as mainnet. `bcrt1q` is the only regtest-segwit prefix.
  if (address.startsWith('bcrt1q') || address.startsWith('bc1q') || address.startsWith('tb1q')) {
    return 'P2WPKH';
  }

  // Taproot, same ordering reason as P2WPKH.
  if (address.startsWith('bcrt1p') || address.startsWith('bc1p') || address.startsWith('tb1p')) {
    return 'P2TR';
  }

  throw new Error('Unsupported address format.');
}

/**
 * Determines whether a given Bitcoin address is a Segregated Witness (SegWit) address.
 *
 * The determination of P2SH addresses as SegWit is based on the assumption that P2SH addresses
 * are being used for SegWit purposes, which may not always be the case.
 */
export function isSegWit(address: string): boolean {
  const addressFormat = getAddressFormat(address);
  return addressFormat !== 'P2PKH';
}

/**
 * Converts a full public key (including the y-coordinate parity byte) into an x-only public key.
 *
 * In the context of Schnorr signatures and Taproot transactions in Bitcoin, public keys are represented
 * as x-only coordinates. This is because Schnorr signatures utilize x-only public keys, which are 32 bytes long
 * and consist only of the x-coordinate of the elliptic curve point.
 *
 * The first byte of a compressed ECDSA public key (0x02 or 0x03) indicates the y-coordinate's parity
 * and is unnecessary for Schnorr signatures. Removing this byte aligns the public key format with the
 * Schnorr and Taproot standards.
 *
 * as seen here: https://github.com/paulmillr/scure-btc-signer/discussions/77
 *
 * @param pubkey - The full public key, including the y-coordinate parity byte at the beginning.
 * @returns The x-only public key, with the y-coordinate parity byte removed.
 */
export function toXOnly(pubkey: Uint8Array): Uint8Array {
  return pubkey.subarray(1, 33);
}
