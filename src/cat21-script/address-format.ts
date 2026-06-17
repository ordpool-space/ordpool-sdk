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
 * Determines the minimum UTXO size based on the Bitcoin address type.
 * Supports both mainnet and testnet address prefixes.
 *
 * This function aims to provide the minimum UTXO size to avoid creating dust outputs.
 * Since P2SH* addresses (starting with '3' on mainnet and '2' on testnet)
 * can represent various types of scripts, including Nested SegWit,
 * a conservative approach is taken by assigning the higher minimum UTXO size applicable
 * to P2SH addresses. P2SH-P2WPKH would allow 540, but 6 sats are small enough to ignore them.
 *
 * Supported address types and their conservative minimum UTXO sizes are as follows:
 * - P2PKH / "Legacy" Pay-to-Public-Key-Hash (mainnet '1', testnet 'm' or 'n'): 546 satoshis
 * - P2SH / Pay-to-Script-Hash including
 *   ... P2SH-P2WPKH / "Nested SegWit" and
 *   ... P2SH-P2WSH / "Pay To Witness Script Hash Wrapped In P2SH" (mainnet '3', testnet '2'): 546 satoshis !
 * - P2WPKH / Native SegWit (mainnet 'bc1q', testnet 'tb1q'): 294 satoshis
 * - P2TR / Taproot (mainnet 'bc1p', testnet 'tb1p'): 330 satoshis
 *
 * Not supported:
 * - P2PK (Pay-to-Public-Key)
 *
 * References for further reading:
 * - https://help.magiceden.io/en/articles/8665399-navigating-bitcoin-dust-understanding-limits-and-safeguarding-your-transactions-on-magic-eden
 * - https://en.bitcoin.it/wiki/List_of_address_prefixes
 * - https://unchained.com/blog/bitcoin-address-types-compared/
 *
 * @param address - The Bitcoin address to evaluate.
 * @returns The conservative minimum number of satoshis that must be held by a UTXO of the given address type to avoid dust outputs.
 * @throws Throws an error if the address type is unsupported.
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
 * Determines the Bitcoin address format based on its prefix.
 *
 * Due to the identical prefixes of P2SH addresses, this function cannot
 * distinguish between different types of P2SH formats (e.g., P2SH-P2WPKH, P2SH-P2WSH)
 * solely based on the address itself. It returns 'P2SH???' to indicate this uncertainty.
 * Additional context or user input is required to accurately identify
 * the specific P2SH format for transaction script creation.
 *
 * Supported address formats are:
 * - P2PKH: Legacy addresses starting with '1' (mainnet) or 'm'/'n' (testnet)
 * - P2SH???: P2SH addresses starting with '3' (mainnet) or '2' (testnet), where
 *            the specific P2SH format is unclear without further context
 * - P2WPKH: Native SegWit addresses starting with 'bc1q' (mainnet) or 'tb1q' (testnet).
 * - P2TR: Taproot addresses starting with 'bc1p' (mainnet) or 'tb1p' (testnet).
 *
 * Not supported:
 * - P2PK (Pay-to-Public-Key)
 *
 * @throws Throws an error if the address format is unsupported.
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
