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

import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

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
 * The change-output dust floor an address's spend will actually use: the
 * per-address-type minimum (`getMinimumUtxoSize`), falling back to 546 (the
 * conservative cross-type floor) when the address prefix isn't recognised.
 *
 * This is the EXACT rule the transfer / offer / inscribe builders apply to
 * decide whether to emit change or absorb it into the fee (see
 * `cat21-transfer.helper.ts`, `cat21-offer.helper.ts`,
 * `inscription.service.helper.ts`). Coin-selection's change-headroom preferred
 * target must use the SAME floor as the builder, or it either wrongly excludes
 * a coin whose change WOULD be emitted (falling back to a dust-cliff coin that
 * over-pays) or falsely counts a coin whose change would be absorbed.
 */
export function changeDustFloor(address: string): number {
  try {
    return getMinimumUtxoSize(address);
  } catch {
    return 546;
  }
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
 * Can this payment address be used to fund an inscribe commit?
 *
 * The inscribe pipeline pre-builds the reveal tx referencing the
 * commit tx's SIMULATION txid (the commit isn't signed yet at that
 * point). This assumes the txid is witness-independent — true for
 * segwit inputs (signature lands in the witness, which is NOT part
 * of the txid preimage). For legacy P2PKH inputs the signature lands
 * in `scriptSig`, which IS in the non-witness serialization, so the
 * real-signed commit has a DIFFERENT txid than the simulation and
 * the pre-built reveal points at a txid that never existed on chain.
 * The commit broadcasts fine, the reveal broadcast fails with
 * `bad-txns-inputs-missingorspent`, and the postage sits locked in
 * the commit output with no key to spend it (the ephemeral key that
 * would sign a fresh reveal against the real commit txid is gone
 * once the flow ends).
 *
 * Consumers use this to gate the inscribe UI: disable the button,
 * show a "switch to Native SegWit or Taproot" banner, refuse before
 * the user commits a fee. The inscribe pipeline itself also throws
 * on this address type as defense-in-depth.
 *
 * P2SH is treated as SUPPORTED — it's assumed to wrap SegWit
 * (P2SH-P2WPKH / Nested SegWit is the common case). The rare
 * non-SegWit P2SH scripts would trip a different failure inside
 * scure at signing time, not a silent postage loss.
 */
export function isInscribeSupportedPaymentAddress(address: string): boolean {
  return getAddressFormat(address) !== 'P2PKH';
}

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

export function getAddressNetwork(address: string): AddressNetworkGroup {
  if (address.startsWith('bcrt1')) return 'regtest';
  if (address.startsWith('bc1') || address.startsWith('1') || address.startsWith('3')) {
    return 'mainnet';
  }
  if (
    address.startsWith('tb1') ||
    address.startsWith('m') ||
    address.startsWith('n') ||
    address.startsWith('2')
  ) {
    return 'testnet';
  }
  throw new Error('Unsupported address format.');
}

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
export function isAddressCompatibleWithNetwork(
  address: string,
  expectedNetworkGroup: AddressNetworkGroup,
): boolean {
  const actual = getAddressNetwork(address);
  if (actual === expectedNetworkGroup) return true;
  // Legacy testnet ↔ regtest ambiguity (shared key bytes, no bech32
  // HRP to disambiguate). Treat the two as compatible only when the
  // address is the legacy / P2SH shape — bech32 prefixes are
  // unambiguous.
  const isLegacy = !address.startsWith('bc1') && !address.startsWith('tb1') && !address.startsWith('bcrt1');
  if (!isLegacy) return false;
  return (
    (actual === 'testnet' && expectedNetworkGroup === 'regtest') ||
    (actual === 'regtest' && expectedNetworkGroup === 'testnet')
  );
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

/**
 * True when `a` and `b` are the SAME Bitcoin address by scriptPubKey,
 * even if the two strings differ. Decodes both to scriptPubKey bytes
 * and byte-compares. This is the canonical address-equivalence check
 * that guards payout / recipient / allowlist addresses, so it lives in
 * ONE place. Defends against:
 *
 *   - BIP173 uppercase/lowercase: `BC1QW508…` and `bc1qw508…` are the
 *     same address (scure accepts both), so a config storing one form
 *     still matches the other.
 *   - Homoglyph swaps (Latin/Cyrillic look-alikes): decode to a
 *     different (or undecodable) script → unequal.
 *   - Mixed encodings: `bc1q…` (P2WPKH) vs `3…` (P2SH-wrapped) decode
 *     to different scripts → correctly unequal.
 *
 * Returns `false` on any decode failure of EITHER address (a config
 * typo / whitespace rejects the candidate without crashing the caller).
 *
 * `network` is the scure network OBJECT (mainnet / testnet / regtest,
 * all structurally `typeof btc.NETWORK`). Callers holding the SDK
 * `Network` enum convert via `toScureNetwork(...)` first.
 */
export function addressesEquivalent(a: string, b: string, network: typeof btc.NETWORK): boolean {
  if (a === b) return true;
  try {
    const scriptA = btc.OutScript.encode(btc.Address(network).decode(a));
    const scriptB = btc.OutScript.encode(btc.Address(network).decode(b));
    return hex.encode(scriptA) === hex.encode(scriptB);
  } catch {
    return false;
  }
}

/**
 * True when `candidate` is equivalent (per `addressesEquivalent`) to
 * any address in `allowlist`.
 */
export function allowlistContainsAddress(
  candidate: string,
  allowlist: ReadonlyArray<string>,
  network: typeof btc.NETWORK,
): boolean {
  return allowlist.some((entry) => addressesEquivalent(candidate, entry, network));
}
