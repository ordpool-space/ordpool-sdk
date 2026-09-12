import { hex } from '@scure/base';

import { findRareSatInRanges, type SatRarity } from '../cat21-mint/sat-rarity.helper';
import type { OrdOutputResponse } from '../cat21-mint/utxo-content.types';
import { getAddressFormat } from '../cat21-script/address-format';
import { buildInputScript } from '../cat21-script/build-input-script';
import { Network, toScureNetwork } from '../network';
import { failInscribe } from './inscribe-errors';
import type { InscribeSatSource } from './inscription-commit.helper';
import { findSatOffset } from './sat-offset';

/**
 * Rare-sat discovery for an inscribe screen: which of a wallet's coins hold a
 * notable sat, and where that sat sits in its coin, so a picker can offer
 * "inscribe onto this one" and hand the result straight to `satTarget`.
 *
 * The work is one `GET /output/<outpoint>` per coin against an ord with a sat
 * index (`--index-sats`; the response carries `sat_ranges`), then the SDK's
 * own rarity walk over those ranges. It lives here so every consumer reads
 * ord's sat ranges the same way instead of re-deriving the rarity ladder.
 */

/** What a picker shows for one of the wallet's coins. */
export interface SatPickerRow<T> {
  /** The caller's own coin, handed back untouched so it can go straight into `satTarget`. */
  utxo: T;
  /** The address ord reports the output at; `null` when the lookup failed. */
  address: string | null;
  /**
   * The rarest sat on this coin and where it sits in it, or `null` when the
   * coin holds only common sats. `offset` is what `satTarget` takes.
   */
  rareSat: { sat: number; offset: number; rarity: SatRarity } | null;
  /**
   * `'scanned'` means ord answered and the row is the truth about this coin;
   * `'unknown'` means the lookup failed and the coin was NOT ruled out.
   */
  status: 'scanned' | 'unknown';
}

export interface FindRareSatsOptions {
  /** Base URL of an ord server with a sat index, e.g. `https://ord.ordpool.space`. */
  ordBaseUrl: string;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Requests in flight at once. Default 4. */
  concurrency?: number;
  /** The fetch to use. Default the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Look up every coin's sat ranges and report the rarest sat each one holds.
 *
 * Rows come back in the order the coins were given, one per coin. A coin whose
 * lookup fails is `status: 'unknown'` rather than "holds nothing", so a screen
 * never tells someone a rare sat is absent when it simply could not ask. An
 * ord without a sat index answers without `sat_ranges`, which reads as a coin
 * of only common sats; point this at an ord that has the index.
 *
 * Pair a picked row with {@link satPaddingRequirement} (against the row's own
 * `address`) to know whether inscribing on it needs a padding coin.
 */
export async function findRareSatsInOutputs<T extends { txid: string; vout: number }>(
  outputs: ReadonlyArray<T>,
  options: FindRareSatsOptions,
): Promise<Array<SatPickerRow<T>>> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const base = options.ordBaseUrl.replace(/\/+$/, '');

  const rows: Array<SatPickerRow<T>> = outputs.map((utxo) => ({
    utxo, address: null, rareSat: null, status: 'unknown',
  }));

  const scan = async (index: number): Promise<void> => {
    const { txid, vout } = outputs[index];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${base}/output/${txid}:${vout}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return;
      const out = (await res.json()) as OrdOutputResponse;
      rows[index] = {
        utxo: outputs[index],
        address: out.address ?? null,
        rareSat: rareSatOf(out.sat_ranges),
        status: 'scanned',
      };
    } catch {
      // Leaves the row 'unknown': a failed lookup is not an answer.
    } finally {
      clearTimeout(timer);
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < outputs.length) await scan(next++);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, outputs.length) }, worker));
  return rows;
}

/** The rarest sat across an output's ranges, with its offset within the output. */
function rareSatOf(
  satRanges: OrdOutputResponse['sat_ranges'],
): SatPickerRow<unknown>['rareSat'] {
  if (satRanges === undefined || satRanges.length === 0) return null;
  // ord reports sat numbers as JSON numbers; the rarity walk is in bigint
  // because it does epoch arithmetic, the offset walk in number because that
  // is what the envelope's satpoint takes. Both are exact: the last sat ever
  // mined is far below Number.MAX_SAFE_INTEGER.
  const hit = findRareSatInRanges(satRanges.map(([s, e]) => [BigInt(s), BigInt(e)] as const));
  if (hit === null) return null;
  const sat = Number(hit.sat);
  const offset = findSatOffset(satRanges, sat);
  if (offset === undefined) return null;
  return { sat, offset, rarity: hit.rarity };
}

/**
 * Turn a picked row into the {@link InscribeSatSource} that `satTarget` kind
 * `in-utxo` takes, deriving the two byte-level fields from the wallet's
 * ordinals public key rather than leaving each consumer to do it:
 *
 *   - `scriptPubKey` is the coin's P2TR OUTPUT script, built from the TWEAKED
 *     output key.
 *   - `tapInternalKey` is the UNTWEAKED x-only internal key, which is what a
 *     key-path signer signs with.
 *
 * Getting those two the wrong way round builds a commit that looks right and
 * cannot be spent, so the derivation runs through the same
 * `buildInputScript` the rest of the SDK signs with, and the result is checked
 * against the address ord reported for the coin: a key that does not produce
 * that address is the wrong key, and throws rather than building silently.
 *
 * Returns `null` when there is nothing to target, which is a row holding no
 * rare sat and a row whose lookup failed (`status: 'unknown'`), so a picker
 * can map its rows without filtering first.
 */
export function inscribeSatSourceFromRow<T extends { txid: string; vout: number; value: number }>(
  row: SatPickerRow<T>,
  args: { ordinalsPublicKey: string | Uint8Array; network: Network },
): InscribeSatSource | null {
  if (row.status !== 'scanned' || row.rareSat === null || row.address === null) return null;
  const address = row.address;

  if (getAddressFormat(address) !== 'P2TR') {
    failInscribe('sat-utxo-must-be-taproot',
      `a sat source must be a P2TR output; ${address} is not`,
      'That coin cannot be inscribed onto: inscribing on a chosen sat needs a Taproot coin.',
      { address });
  }
  const ordinalsPublicKey = typeof args.ordinalsPublicKey === 'string'
    ? hex.decode(args.ordinalsPublicKey)
    : args.ordinalsPublicKey;
  const { scriptData, tapInternalKey } = buildInputScript({
    paymentAddress: address,
    paymentPublicKey: ordinalsPublicKey,
    isSimulation: false,
    network: toScureNetwork(args.network),
  });
  if (tapInternalKey === undefined) {
    throw new Error('buildInputScript returned no tapInternalKey for a P2TR address');
  }
  if (scriptData.address !== address) {
    failInscribe('sat-utxo-key-mismatch',
      `the ordinals public key derives ${scriptData.address}, not ${address}, so it does not own this coin`,
      'That coin is not at your wallet\'s ordinals address, so your wallet cannot sign for it.',
      { address, derivedAddress: scriptData.address });
  }
  return {
    txid: row.utxo.txid,
    vout: row.utxo.vout,
    value: row.utxo.value,
    scriptPubKey: scriptData.script,
    tapInternalKey,
    address,
    offset: row.rareSat.offset,
  };
}
