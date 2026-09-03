/**
 * Fetch-based classification of one outpoint's ordinals content. Fires the
 * two ord `/output` requests in parallel (the full ord for inscriptions +
 * runes + rare sats; cat21-ord for cats) and delegates the decision to
 * `classifyUtxoContent`, so the "is this UTXO spendable" logic is shared
 * byte-for-byte with the `UtxoContentScanner`.
 *
 * Building block for `makeWatchOnlyProbe`. Throws on any non-2xx from
 * either ord (the caller decides how to treat an unclassifiable outpoint;
 * `makeWatchOnlyProbe` excludes it from spendable funds, conservatively).
 */

import {
  classifyUtxoContent,
  UtxoContentClassification,
} from '../../cat21-mint/utxo-content.classify';
import {
  Cat21OrdOutputResponse,
  OrdOutputResponse,
} from '../../cat21-mint/utxo-content.types';

export interface ClassifyOutpointOptions {
  /** Full ord (inscriptions + runes + rare sats), e.g. `https://ord.ordpool.space`. */
  ordApiUrl: string;
  /** cat21-ord (`--index-cat21`, cats), e.g. `https://ord.cat21.space`. */
  cat21OrdApiUrl: string;
  signal?: AbortSignal;
}

export interface OutpointClassification extends UtxoContentClassification {
  outpoint: string;
}

export async function classifyOutpoint(
  outpoint: string,
  options: ClassifyOutpointOptions,
): Promise<OutpointClassification> {
  const [ord, cat21Ord] = await Promise.all([
    fetchOutput<OrdOutputResponse>(options.ordApiUrl, outpoint, options.signal),
    fetchOutput<Cat21OrdOutputResponse>(options.cat21OrdApiUrl, outpoint, options.signal),
  ]);
  return { outpoint, ...classifyUtxoContent(ord, cat21Ord) };
}

async function fetchOutput<T>(baseUrl: string, outpoint: string, signal?: AbortSignal): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, '')}/output/${outpoint}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) {
    throw new Error(`classifyOutpoint: ${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}
