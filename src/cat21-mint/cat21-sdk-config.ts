import { InjectionToken } from '@angular/core';

/**
 * Runtime config the cat21-mint services need. Provided by the
 * consumer's DI; the SDK doesn't know about specific environments.
 *
 * - `mempoolApiUrl` — base URL of the Esplora-compatible backend
 *   (utxo lookups, raw-tx fetch, broadcast). The network the URL
 *   points at must match `bitcoinNetwork`; the consumer picks both.
 * - `cat21ApiUrl` — base URL of the cat21-indexer REST API
 *   (status, cats list). Same rule — match the URL to
 *   `bitcoinNetwork`.
 * - `ordApiUrl` — base URL of an ord JSON API (typically our ord
 *   instance at `ord.ordpool.space`). Used by `UtxoContentScanner`
 *   to detect inscriptions + runes per outpoint before the user
 *   mints with that UTXO.
 * - `cat21OrdApiUrl` — base URL of cat21-ord (typically
 *   `ord.cat21.space`). Same scanner uses it to detect CAT-21 cats
 *   per outpoint.
 */
export interface Cat21SdkConfig {
  mempoolApiUrl: string;
  cat21ApiUrl: string;
  ordApiUrl: string;
  cat21OrdApiUrl: string;
}

export const cat21Config = new InjectionToken<Cat21SdkConfig>('cat21Config');
