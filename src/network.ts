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
 * Convert to sats-connect's BitcoinNetworkType (used by Xverse's
 * getAddress / signTransaction).
 *
 * sats-connect@1.1.2's enum only declares Mainnet + Testnet, but at
 * runtime Xverse accepts the literal strings "Signet" and "Regtest"
 * too — Xverse's mismatch check compares the request type to the
 * wallet's active chain `mode`, so a Regtest-mode wallet only
 * matches `type: "Regtest"`. Cast through `as BitcoinNetworkType`
 * for the variants that aren't in the published enum yet.
 */
export function toBitcoinNetworkType(network: Network): BitcoinNetworkType {
  if (network === Network.Mainnet)   return BitcoinNetworkType.Mainnet;
  if (network === Network.Regtest)   return 'Regtest'  as BitcoinNetworkType;
  if (network === Network.Signet)    return 'Signet'   as BitcoinNetworkType;
  if (network === Network.Testnet4)  return 'Testnet4' as BitcoinNetworkType;
  return BitcoinNetworkType.Testnet;
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
