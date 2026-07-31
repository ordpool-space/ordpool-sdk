import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';

import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType, WalletInfo } from './wallet.service.types';

/**
 * Non-native regtest wallets (Leather / Unisat / Wizz / OKX / Oyl)
 * hard-code mainnet HRP in their `getAddresses` responses regardless
 * of the network the dapp asked for. When a consumer initialises the
 * SDK with `Network.Regtest`, this helper post-processes the wallet's
 * returned `WalletInfo` and swaps its payment + ordinals addresses for
 * their `bcrt`-prefixed equivalents, derived from the same pubkeys via
 * `@scure/btc-signer`.
 *
 * Correctness rests on: scriptPubKey bytes are HRP-independent, so a
 * signature the wallet produces against ITS mainnet address hash also
 * verifies against the equivalent regtest scriptPubKey (matching bytes
 * modulo the human-readable prefix). The signer-side companion — see
 * `toWireNetworkFor(walletType, network)` — takes care of passing
 * `network: 'mainnet'` to the wallet's `signPsbt` even when the app
 * asked for regtest, so the wallet unlocks its mainnet-derived key.
 *
 * Native-regtest wallets (Xverse, Cat21Wallet, Alby) skip this: their
 * connectors already return `bcrt1*` when asked with `Network.Regtest`.
 */
export function toRegtestWalletInfo(info: WalletInfo): WalletInfo {
  return {
    ...info,
    paymentAddress:  toRegtestAddress(info.paymentAddress,  info.paymentPublicKey),
    ordinalsAddress: toRegtestAddress(info.ordinalsAddress, info.ordinalsPublicKey),
  };
}

/**
 * Detect the address type from its mainnet HRP / prefix and re-derive
 * it under the regtest network from the same pubkey. Supports the four
 * address shapes any of our five non-native wallets actually returns:
 *   - `bc1q…` → P2WPKH (Native SegWit)
 *   - `bc1p…` → P2TR (Taproot)
 *   - `3…`    → P2SH-wrapped-P2WPKH (Nested SegWit)
 *   - `1…`    → P2PKH (Legacy)
 *
 * P2PKH is included because Unisat's user-selectable address-type UI
 * exposes it; we throw a targeted error for anything that doesn't match
 * one of the four rather than returning silently-wrong bytes.
 */
export function toRegtestAddress(mainnetAddress: string, publicKeyHex: string): string {
  const regtest = toScureNetwork(Network.Regtest);
  const pubkey = hex.decode(publicKeyHex);

  if (mainnetAddress.startsWith('bc1q')) {
    return btc.p2wpkh(pubkey, regtest).address!;
  }
  if (mainnetAddress.startsWith('bc1p')) {
    // BIP-86 tap-internal-key = x-only (32 bytes). Compressed pubkeys
    // (33 bytes, 02/03-prefixed) drop their parity byte.
    const xonly = pubkey.length === 33 ? pubkey.slice(1, 33) : pubkey;
    return btc.p2tr(xonly, undefined, regtest).address!;
  }
  if (mainnetAddress.startsWith('3')) {
    return btc.p2sh(btc.p2wpkh(pubkey, regtest), regtest).address!;
  }
  if (mainnetAddress.startsWith('1')) {
    return btc.p2pkh(pubkey, regtest).address!;
  }
  throw new Error(
    `toRegtestAddress: unsupported address type for "${mainnetAddress}" ` +
    `(supported prefixes: bc1q, bc1p, 3, 1)`,
  );
}

/**
 * Wallet-side network arg for `signPsbt`. Native-regtest wallets get
 * the app's actual `network`; mainnet-only wallets (Leather / Unisat /
 * Wizz / OKX / Oyl) get `Network.Mainnet` even when the app asked for
 * `Network.Regtest`, so the wallet unlocks its mainnet-derived key
 * (which produces a signature that verifies against the equivalent
 * regtest scriptPubKey — see `toRegtestWalletInfo`'s docstring).
 *
 * Non-regtest networks pass through unchanged.
 */
export function toWireNetworkFor(
  walletType: KnownOrdinalWalletType,
  appNetwork: Network,
): Network {
  if (appNetwork !== Network.Regtest) return appNetwork;
  switch (walletType) {
    case KnownOrdinalWalletType.xverse:
    case KnownOrdinalWalletType.cat21wallet:
    case KnownOrdinalWalletType.alby:
      return Network.Regtest;
    default:
      return Network.Mainnet;
  }
}
