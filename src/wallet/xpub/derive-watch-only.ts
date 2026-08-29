/**
 * Watch-only address derivation from an account-level extended public
 * key (xpub / ypub / zpub / tpub / upub / vpub).
 *
 * This is the missing first layer of the watch-only ("xpub") wallet:
 * the SDK already builds + signs + broadcasts a watch-only PSBT
 * (`psbtExportSigner`, proven in `e2e/regtest/psbt-export-*.spec.ts`),
 * but a consumer picker had no way to turn a pasted extended key into
 * the `{ ordinalsAddress, paymentAddress, publicKey }` identity every
 * operation needs. This derives those addresses so all three consumer
 * sites (cat21.space, ordpool.space, cubes) share ONE derivation and
 * cannot disagree on which address a given xpub maps to.
 *
 * Supports both wallet exports the CAT-21 HOWTO targets — Electrum and
 * Sparrow — plus Coldcard / Ledger / Trezor, because they all export
 * the same BIP-32 account-level extended keys. Script type is carried
 * in the SLIP-132 version-byte prefix where the wallet uses one
 * (ypub/zpub/upub/vpub); plain xpub/tpub are script-type-ambiguous
 * (BIP-44 legacy vs BIP-86 taproot share the same version bytes), so
 * the caller supplies `scriptType` for those.
 *
 * Pure + Angular-free (lives in `/core`): no I/O. The scan/auto-pick
 * step that picks WHICH derived address is the active identity takes
 * these outputs plus a UTXO-fetch callback; see the scan helper.
 */

import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../../network';

const base58checkSha256 = base58check(sha256);

/** The four address encodings a watch-only export can use. */
export type WatchOnlyScriptType = 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh';

/** Stable failure codes for watch-only key derivation. */
export type WatchOnlyDeriveErrorCode =
  | 'invalid-key'
  | 'unrecognised-prefix'
  | 'network-mismatch'
  | 'script-type-conflict'
  | 'script-type-ambiguous'
  | 'invalid-args'
  | 'derivation-failed';

/**
 * Error thrown by watch-only key derivation, carrying a STABLE `code` so
 * consumers branch on `err.code === 'script-type-ambiguous'` (e.g. to prompt
 * for an account type) rather than matching the human-readable `message`,
 * which is free to change. `code` is a plain string field, cross-realm safe;
 * prefer it over `instanceof`.
 */
export class WatchOnlyDeriveError extends Error {
  readonly code: WatchOnlyDeriveErrorCode;
  constructor(code: WatchOnlyDeriveErrorCode, message: string) {
    super(message);
    this.name = 'WatchOnlyDeriveError';
    this.code = code;
  }
}

interface VersionInfo {
  /** undefined = the prefix is script-type-ambiguous (plain xpub/tpub). */
  scriptType?: WatchOnlyScriptType;
  mainnet: boolean;
}

/**
 * SLIP-132 extended-public-key version bytes → implied script type +
 * network. Sources: BIP-32 (xpub/tpub, 0x0488b21e / 0x043587cf) and
 * SLIP-132 (ypub/zpub/upub/vpub). Taproot (BIP-86) has NO SLIP-132
 * prefix — Sparrow/Electrum export a taproot account as a plain
 * xpub/tpub — so 0x0488b21e / 0x043587cf are ambiguous (BIP-44 legacy
 * vs BIP-86 taproot) and map to `scriptType: undefined`.
 */
const VERSION_BYTES: Readonly<Record<number, VersionInfo>> = {
  0x0488b21e: { scriptType: undefined, mainnet: true },       // xpub
  0x049d7cb2: { scriptType: 'p2sh-p2wpkh', mainnet: true },   // ypub (BIP-49)
  0x04b24746: { scriptType: 'p2wpkh', mainnet: true },        // zpub (BIP-84)
  0x043587cf: { scriptType: undefined, mainnet: false },      // tpub
  0x044a5262: { scriptType: 'p2sh-p2wpkh', mainnet: false },  // upub (BIP-49 testnet)
  0x045f1cf6: { scriptType: 'p2wpkh', mainnet: false },       // vpub (BIP-84 testnet)
};

/**
 * Standard BIP-32 version bytes per network. HDKey.fromExtendedKey
 * checks the key's version against these, so we normalize the SLIP-132
 * prefix to the network's standard public bytes AND pass the matching
 * versions (its default is mainnet-only, which rejects a tpub).
 */
const STANDARD_VERSIONS = {
  mainnet: { private: 0x0488ade4, public: 0x0488b21e },
  testnet: { private: 0x04358394, public: 0x043587cf },
};

/** A single derived receive/change address with the material an operation needs. */
export interface WatchOnlyAddress {
  /** Encoded address in the requested script type + network. */
  address: string;
  /** 33-byte compressed public key at this path, hex. */
  publicKeyHex: string;
  /** Path relative to the supplied account key, e.g. "0/3" (chain/index). */
  path: string;
  /** 0 = external/receive chain, 1 = internal/change chain. */
  chain: 0 | 1;
  index: number;
}

export interface DeriveWatchOnlyArgs {
  /** Account-level extended PUBLIC key (xpub/ypub/zpub/tpub/upub/vpub). */
  extendedPublicKey: string;
  network: Network;
  /**
   * Required when the prefix is ambiguous (plain xpub/tpub). For
   * SLIP-132 prefixes (ypub/zpub/upub/vpub) the script type is implied;
   * passing a conflicting value throws.
   */
  scriptType?: WatchOnlyScriptType;
  /** 0 = receive (default), 1 = change. */
  chain?: 0 | 1;
  /** First index to derive (default 0). */
  startIndex?: number;
  /** How many consecutive indexes to derive (default 20, the BIP-44 gap limit). */
  count?: number;
}

function isMainnetKeyPrefix(network: Network): boolean {
  return network === Network.Mainnet;
}

/**
 * Read the 4 version bytes, validate them against the network, resolve
 * the script type, and normalize the key to standard BIP-32 version
 * bytes so `HDKey.fromExtendedKey` accepts it (the key material is
 * identical; only the SLIP-132 version bytes differ).
 */
function parseAccountKey(
  extendedPublicKey: string,
  network: Network,
  scriptTypeOverride?: WatchOnlyScriptType,
): { hd: HDKey; scriptType: WatchOnlyScriptType } {
  let payload: Uint8Array;
  try {
    payload = base58checkSha256.decode(extendedPublicKey);
  } catch {
    throw new WatchOnlyDeriveError('invalid-key', 'Watch-only: not a valid base58check extended key');
  }
  if (payload.length !== 78) {
    throw new WatchOnlyDeriveError('invalid-key', `Watch-only: extended key has wrong length (${payload.length}, expected 78)`);
  }

  const version = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
  const info = VERSION_BYTES[version >>> 0];
  if (!info) {
    throw new WatchOnlyDeriveError('unrecognised-prefix', `Watch-only: unrecognised extended-key prefix (version 0x${version.toString(16)})`);
  }

  const wantMainnet = isMainnetKeyPrefix(network);
  if (info.mainnet !== wantMainnet) {
    throw new WatchOnlyDeriveError(
      'network-mismatch',
      `Watch-only: key is a ${info.mainnet ? 'mainnet' : 'testnet'} extended key but network is ${network}`,
    );
  }

  let scriptType: WatchOnlyScriptType;
  if (info.scriptType) {
    if (scriptTypeOverride && scriptTypeOverride !== info.scriptType) {
      throw new WatchOnlyDeriveError(
        'script-type-conflict',
        `Watch-only: key prefix implies ${info.scriptType} but scriptType=${scriptTypeOverride} was given`,
      );
    }
    scriptType = info.scriptType;
  } else {
    if (!scriptTypeOverride) {
      throw new WatchOnlyDeriveError(
        'script-type-ambiguous',
        'Watch-only: this key prefix (xpub/tpub) is script-type-ambiguous; pass scriptType (p2tr for a taproot account, p2pkh for legacy)',
      );
    }
    scriptType = scriptTypeOverride;
  }

  // Normalize version bytes to the network's standard xpub/tpub so
  // HDKey parses SLIP-132 prefixes (ypub/zpub/upub/vpub) too.
  const versions = wantMainnet ? STANDARD_VERSIONS.mainnet : STANDARD_VERSIONS.testnet;
  const normalized = payload.slice();
  normalized[0] = (versions.public >>> 24) & 0xff;
  normalized[1] = (versions.public >>> 16) & 0xff;
  normalized[2] = (versions.public >>> 8) & 0xff;
  normalized[3] = versions.public & 0xff;

  // HDKey defaults to mainnet versions; pass the network's explicitly
  // so a normalized tpub is not rejected with "Version mismatch".
  const hd = HDKey.fromExtendedKey(base58checkSha256.encode(normalized), versions);
  return { hd, scriptType };
}

/** Encode a compressed pubkey as an address in the requested script type + network. */
function encodeAddress(
  publicKey: Uint8Array,
  scriptType: WatchOnlyScriptType,
  scureNetwork: typeof btc.NETWORK,
): string {
  switch (scriptType) {
    case 'p2tr':
      return btc.p2tr(publicKey.slice(1, 33), undefined, scureNetwork, true).address!;
    case 'p2wpkh':
      return btc.p2wpkh(publicKey, scureNetwork).address!;
    case 'p2sh-p2wpkh':
      return btc.p2sh(btc.p2wpkh(publicKey, scureNetwork), scureNetwork).address!;
    case 'p2pkh':
      return btc.p2pkh(publicKey, scureNetwork).address!;
  }
}

/**
 * Derive a run of watch-only addresses from an account extended public
 * key. Non-hardened `chain/index` children are derivable from a public
 * key alone (no private key), which is exactly why a watch-only xpub
 * works.
 */
export function deriveWatchOnlyAddresses(args: DeriveWatchOnlyArgs): WatchOnlyAddress[] {
  const chain: 0 | 1 = args.chain ?? 0;
  const startIndex = args.startIndex ?? 0;
  const count = args.count ?? 20;
  if (count < 0) throw new WatchOnlyDeriveError('invalid-args', 'Watch-only: count must be non-negative');
  if (startIndex < 0) throw new WatchOnlyDeriveError('invalid-args', 'Watch-only: startIndex must be non-negative');

  const { hd, scriptType } = parseAccountKey(args.extendedPublicKey, args.network, args.scriptType);
  const scureNetwork = toScureNetwork(args.network);
  const chainNode = hd.deriveChild(chain);

  const out: WatchOnlyAddress[] = [];
  for (let i = 0; i < count; i++) {
    const index = startIndex + i;
    const child = chainNode.deriveChild(index);
    if (!child.publicKey) throw new WatchOnlyDeriveError('derivation-failed', `Watch-only: no public key at ${chain}/${index}`);
    out.push({
      address: encodeAddress(child.publicKey, scriptType, scureNetwork),
      publicKeyHex: hex.encode(child.publicKey),
      path: `${chain}/${index}`,
      chain,
      index,
    });
  }
  return out;
}

/** Resolve the effective script type for an extended key without deriving. */
export function watchOnlyScriptType(
  extendedPublicKey: string,
  network: Network,
  scriptTypeOverride?: WatchOnlyScriptType,
): WatchOnlyScriptType {
  return parseAccountKey(extendedPublicKey, network, scriptTypeOverride).scriptType;
}
