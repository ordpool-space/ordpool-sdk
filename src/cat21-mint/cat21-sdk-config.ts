import { InjectionToken } from '@angular/core';

/**
 * Runtime config the cat21-mint services need. Provided by the
 * consumer's DI; the SDK doesn't know about specific environments.
 *
 * - `mempoolApiUrl` — base URL of the Esplora-compatible backend
 *   (utxo lookups, raw-tx fetch, broadcast). Mainnet URL.
 * - `mempoolApiUrlTestnet` — same shape, used when the wallet flips
 *   to testnet. The frontend currently falls back to
 *   `https://blockstream.info/testnet` here.
 * - `cat21ApiUrl` — base URL of the cat21-indexer REST API
 *   (status, cats list, whitelist lookup). Mainnet URL; testnet
 *   suffixes "/testnet" automatically.
 */
export interface Cat21SdkConfig {
  mempoolApiUrl: string;
  mempoolApiUrlTestnet: string;
  cat21ApiUrl: string;
}

export const CAT21_SDK_CONFIG = new InjectionToken<Cat21SdkConfig>('CAT21_SDK_CONFIG');
