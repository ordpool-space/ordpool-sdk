/**
 * The ordinals-safe watch-only probe factory.
 *
 * `scanWatchOnly` needs a `probe(address)` that reports, per derived
 * address, whether it holds a cat (ordinals identity) and how many
 * SPENDABLE sats it has (payment identity). "Spendable" must exclude every
 * kind of ordinals content a user could burn: cats, regular inscriptions,
 * runes, and rare sats. None of those correlate with UTXO size, so the only
 * honest answer comes from the indexes, never a 546-sat heuristic.
 *
 * This is the single shared implementation of that probe, so all consumers
 * (cat21.space, ordpool.space, cubes) wire ONE factory instead of each
 * hand-rolling funded/fundedSats and re-introducing size heuristics.
 *
 * Per address:
 *   - `hasCat`  = the cat index (cat21-ord `/address` -> `cat_numbers`)
 *                 reports at least one cat. Address-level, authoritative.
 *   - `funded` / `fundedSats` = only UTXOs `classifyOutpoint` confirms clean
 *                 (no inscription, rune, cat, or rare sat) count as spendable.
 *                 A UTXO whose classification fails is EXCLUDED, never assumed
 *                 spendable.
 */

import { catsAtAddress } from './cats-at-address';
import { classifyOutpoint } from './classify-outpoint';
import { AddressProbe } from './scan-watch-only';

export interface WatchOnlyProbeConfig {
  /**
   * esplora / electrs base for the address UTXO set, e.g.
   * `https://api.ordpool.space`. Queried at `/address/{address}/utxo`.
   */
  esploraApiUrl: string;
  /** Full ord (inscriptions + runes + rare sats), e.g. `https://ord.ordpool.space`. */
  ordApiUrl: string;
  /** cat21-ord (`--index-cat21`, cats), e.g. `https://ord.cat21.space`. */
  cat21OrdApiUrl: string;
  signal?: AbortSignal;
}

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
}

/**
 * Build the ordinals-safe `probe` for {@link scanWatchOnly}. Pure +
 * Angular-free: native `fetch`, composed from the same `classifyOutpoint`
 * the Angular `UtxoContentScanner` delegates to.
 */
export function makeWatchOnlyProbe(
  config: WatchOnlyProbeConfig,
): (address: string) => Promise<AddressProbe> {
  return async (address: string): Promise<AddressProbe> => {
    const [utxos, cats] = await Promise.all([
      fetchUtxos(config.esploraApiUrl, address, config.signal),
      catsAtAddress(address, { cat21OrdApiUrl: config.cat21OrdApiUrl, signal: config.signal }),
    ]);

    const classified = await Promise.all(
      utxos.map(async (u) => {
        try {
          const c = await classifyOutpoint(`${u.txid}:${u.vout}`, {
            ordApiUrl: config.ordApiUrl,
            cat21OrdApiUrl: config.cat21OrdApiUrl,
            signal: config.signal,
          });
          return { value: u.value, clean: c.clean };
        } catch {
          // Unclassifiable outpoint (ord 404 / network): exclude from
          // spendable funds rather than risk spending ordinals content.
          return { value: u.value, clean: false };
        }
      }),
    );

    const spendable = classified.filter((r) => r.clean);
    return {
      funded: spendable.length > 0,
      fundedSats: spendable.reduce((sum, r) => sum + r.value, 0),
      hasCat: cats.length > 0,
    };
  };
}

async function fetchUtxos(esploraApiUrl: string, address: string, signal?: AbortSignal): Promise<EsploraUtxo[]> {
  const url = `${esploraApiUrl.replace(/\/+$/, '')}/address/${encodeURIComponent(address)}/utxo`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (response.status === 404) return []; // address never seen -> no UTXOs
  if (!response.ok) {
    throw new Error(`makeWatchOnlyProbe: ${url} returned ${response.status}`);
  }
  return (await response.json()) as EsploraUtxo[];
}
