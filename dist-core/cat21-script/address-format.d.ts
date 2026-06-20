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
export declare function getMinimumUtxoSize(address: string): number;
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
export declare function getAddressFormat(address: string): 'P2WPKH' | 'P2SH???' | 'P2TR' | 'P2PKH';
/**
 * Determines whether a given Bitcoin address is a Segregated Witness (SegWit) address.
 *
 * The determination of P2SH addresses as SegWit is based on the assumption that P2SH addresses
 * are being used for SegWit purposes, which may not always be the case.
 */
export declare function isSegWit(address: string): boolean;
/**
 * Coarse network grouping reachable from an address prefix.
 *
 *   'mainnet'  — clearly mainnet (`1` / `3` / `bc1` / `bc1p`).
 *   'regtest'  — clearly regtest (`bcrt1` / `bcrt1p`).
 *   'testnet'  — testnet-or-signet bech32 (`tb1` / `tb1p`), OR any of
 *                the legacy testnet/regtest/signet bytes (`m` / `n` /
 *                `2`). Legacy regtest shares the same key bytes as
 *                testnet, so the address alone can't disambiguate.
 *
 * Consumers use this to verify the wallet's connected network
 * matches what the dapp expects — same address prefix is the
 * cheapest fact available, no extra wallet calls, no popup.
 */
export type AddressNetworkGroup = 'mainnet' | 'regtest' | 'testnet';
export declare function getAddressNetwork(address: string): AddressNetworkGroup;
/**
 * `true` when the address could plausibly belong to the network. The
 * legacy testnet / regtest / signet share key bytes so an `m...`
 * address compares true against any non-mainnet network. Use this
 * for the consumer's "wrong-network" red warning — false means
 * "definitely don't sign here".
 *
 * Network values map to address groups as follows:
 *   - `Network.Mainnet`  → 'mainnet'
 *   - `Network.Regtest`  → 'regtest' (also accepts 'testnet' for the
 *                          legacy-byte ambiguity)
 *   - `Network.Testnet3 / Testnet4 / Signet` → 'testnet' (also
 *                          accepts 'regtest' for the same reason)
 */
export declare function isAddressCompatibleWithNetwork(address: string, expectedNetworkGroup: AddressNetworkGroup): boolean;
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
export declare function toXOnly(pubkey: Uint8Array): Uint8Array;
//# sourceMappingURL=address-format.d.ts.map