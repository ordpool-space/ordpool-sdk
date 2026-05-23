import * as btc from '@scure/btc-signer';
import { BitcoinNetworkType } from 'sats-connect';

/**
 * Bitcoin network the SDK is operating on. Matches the bitcoinjs /
 * noble convention: explicit enum, not a boolean, `isMainnet` flattens
 * four distinct testnets into one, which has bitten us before.
 *
 * Today only `Mainnet` is exercised in production (ordpool no longer
 * routes a testnet UI). The other variants exist so a future Node
 * script or CLI can target them without re-shaping the API.
 */
export enum Network {
  Mainnet = 'mainnet',
  Testnet3 = 'testnet3',
  Testnet4 = 'testnet4',
  Signet = 'signet',
  Regtest = 'regtest',
}

/**
 * Regtest uses the same key/script prefixes as testnet but a
 * different bech32 HRP (`bcrt` not `tb`). @scure/btc-signer doesn't
 * ship a regtest constant, we provide one so `Network.Regtest`
 * actually round-trips through the signer without yielding `tb1q…`
 * addresses that bitcoind in regtest mode then rejects.
 */
const REGTEST_NETWORK: typeof btc.NETWORK = {
  bech32: 'bcrt',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

/**
 * Convert to @scure/btc-signer's network object. Mainnet -> NETWORK,
 * Regtest -> a hand-rolled `bcrt`-prefixed network object, all
 * remaining testnet variants -> TEST_NETWORK (scure doesn't
 * distinguish testnet3 / testnet4 / signet at this layer).
 */
export function toScureNetwork(network: Network): typeof btc.NETWORK {
  if (network === Network.Mainnet) return btc.NETWORK;
  if (network === Network.Regtest) return REGTEST_NETWORK;
  return btc.TEST_NETWORK;
}

/**
 * Convert to sats-connect's BitcoinNetworkType. v4+ declares all
 * five variants natively (Mainnet, Testnet, Testnet4, Signet,
 * Regtest), so the v1-era `as BitcoinNetworkType` casts can go.
 *
 * Xverse's mismatch-check is string-equality between the request
 * `network.type` and the wallet's active chain `mode`; v4's enum
 * values match Xverse's mode strings exactly (one of the reasons
 * upgrading was worth doing).
 */
export function toBitcoinNetworkType(network: Network): BitcoinNetworkType {
  if (network === Network.Mainnet)   return BitcoinNetworkType.Mainnet;
  if (network === Network.Testnet3)  return BitcoinNetworkType.Testnet;
  if (network === Network.Testnet4)  return BitcoinNetworkType.Testnet4;
  if (network === Network.Signet)    return BitcoinNetworkType.Signet;
  if (network === Network.Regtest)   return BitcoinNetworkType.Regtest;
  throw new Error(`Unsupported Bitcoin network: ${network}`);
}

/**
 * Leather wallet's `network` field accepts these five strings.
 * Testnet variants flatten to 'testnet'.
 */
export function toLeatherNetworkString(network: Network): 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet' {
  switch (network) {
    case Network.Mainnet: return 'mainnet';
    case Network.Signet: return 'signet';
    case Network.Regtest: return 'devnet';
    default: return 'testnet';
  }
}
