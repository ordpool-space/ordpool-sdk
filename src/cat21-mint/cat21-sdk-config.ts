import { InjectionToken } from '@angular/core';

/**
 * Runtime config the cat21-mint services need. Provided by the
 * consumer's DI; the SDK doesn't know about specific environments.
 *
 * - `mempoolApiUrl` — base URL of the Esplora-compatible backend
 *   (utxo lookups, raw-tx fetch, broadcast). The network the URL
 *   points at must match `bitcoinNetwork`; the consumer picks both.
 * - `cat21ApiUrl` — base URL of the cat21-indexer REST API
 *   (status, cats list, whitelist lookup). Same rule — match
 *   the URL to `bitcoinNetwork`.
 */
export interface Cat21SdkConfig {
  mempoolApiUrl: string;
  cat21ApiUrl: string;
}

export const cat21Config = new InjectionToken<Cat21SdkConfig>('cat21Config');
