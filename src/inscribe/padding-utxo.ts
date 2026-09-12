import type { CardinalUtxoCandidate } from '../cat21-fee/ord-coin-select';
import { selectCardinalUtxo } from '../cat21-fee/ord-coin-select';
import { satPaddingRequirement } from './sat-offset';

/**
 * Choosing the second coin that pads a chosen sat's alignment output.
 *
 * A sat that sits partway into its coin leaves the sats before it as their own
 * output, and below the dust limit of the address that output goes to, Bitcoin
 * will not relay it. ord covers the difference by pulling further wallet inputs
 * in (`transaction_builder.rs`, `pad_alignment_output`); the SDK takes one such
 * coin as `paddingUtxo`. This picks it.
 */

/** What the padding coin is short of, and which coin covers it. */
export type PaddingSelection<T> =
  | { kind: 'not-needed' }
  | { kind: 'selected'; utxo: T; shortfallSats: number }
  | {
      kind: 'none-covers';
      shortfallSats: number;
      /** The biggest spendable coin offered, or 0 when none was. */
      largestAvailableSats: number;
    };

export interface SelectPaddingUtxoOptions {
  /** Offset of the chosen sat within its coin. */
  satOffset: number;
  /**
   * Where the padding output goes, whose dust floor decides the shortfall: the
   * sat's OWN coin address for a sat source (`satTarget` kind `in-utxo`), the
   * payment address for a sat inside the funding coin.
   */
  paddingAddress: string;
  /**
   * Coins this transaction already spends, `"<txid>:<vout>"`, so the funding
   * coin and the sat's own coin are never picked a second time.
   */
  excludeOutpoints?: ReadonlyArray<string>;
}

/**
 * Pick the coin that pads a chosen sat's alignment output, or say why none
 * does.
 *
 * `candidates` must be coins that are safe to spend at the wallet's PAYMENT
 * address: the padding coin is spent, so passing a coin carrying an
 * inscription, a rune or a rare sat would destroy it. Pass the same
 * scan-classified set the funding pick uses, never a raw UTXO list.
 *
 * Of the coins that cover the shortfall the SMALLEST wins, so the least is
 * parked in the padding output and the commit carries the least weight. ord
 * instead takes its closest-under candidate and LOOPS, adding inputs until the
 * output clears dust; the SDK's commit takes a single padding input, so it
 * needs one coin that covers the whole shortfall on its own. The shortfall is
 * always under one dust limit, so any ordinary coin covers it; a wallet whose
 * every spare coin is smaller than that reports `none-covers` rather than
 * combining several.
 */
export function selectPaddingUtxo<T extends CardinalUtxoCandidate>(
  candidates: ReadonlyArray<T>,
  options: SelectPaddingUtxoOptions,
): PaddingSelection<T> {
  const { needsPadding, shortfallSats } = satPaddingRequirement(options.satOffset, options.paddingAddress);
  if (!needsPadding) return { kind: 'not-needed' };

  const excluded = new Set(options.excludeOutpoints ?? []);
  const spendable = candidates.filter((u) => !excluded.has(`${u.txid}:${u.vout}`));
  const covering = spendable.filter((u) => u.value >= shortfallSats);

  if (covering.length === 0) {
    return {
      kind: 'none-covers',
      shortfallSats,
      largestAvailableSats: spendable.reduce((max, u) => Math.max(max, u.value), 0),
    };
  }
  // Every candidate covers, so ord's best-fit resolves to the smallest of them,
  // with ord's own ascending-outpoint tie-break.
  const utxo = selectCardinalUtxo(covering, shortfallSats, false);
  if (utxo === null) throw new Error('selectCardinalUtxo returned nothing for a non-empty candidate set');
  return { kind: 'selected', utxo: utxo as T, shortfallSats };
}
