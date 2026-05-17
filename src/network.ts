import * as btc from '@scure/btc-signer';
import { BitcoinNetworkType } from 'sats-connect';

/**
 * Bitcoin network the SDK is operating on. Matches the bitcoinjs /
 * noble convention: explicit enum, not a boolean — `isMainnet` flattens
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
 * Convert to @scure/btc-signer's network object. @scure doesn't
 * distinguish testnet variants — all map to TEST_NETWORK.
 */
export function toScureNetwork(network: Network): typeof btc.NETWORK {
  return network === Network.Mainnet ? btc.NETWORK : btc.TEST_NETWORK;
}

/**
 * Convert to sats-connect's BitcoinNetworkType enum (used by Xverse's
 * getAddress / signTransaction). Same testnet-flattening as scure.
 */
export function toBitcoinNetworkType(network: Network): BitcoinNetworkType {
  return network === Network.Mainnet ? BitcoinNetworkType.Mainnet : BitcoinNetworkType.Testnet;
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
