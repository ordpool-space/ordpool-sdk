import { getMinimumUtxoSize } from '../cat21-script/address-format';

/**
 * The offset of `sat` within an output, from the output's sat ranges as ord
 * reports them (`GET /output/<outpoint>` with `--index-sats`: `sat_ranges`,
 * `[start, end)` pairs in the output's sat order). This is how ord's
 * `wallet inscribe --sat <SAT>` finds the satpoint
 * (cat21-ord src/wallet.rs, `find_sat_in_outputs`), and the result is what
 * `satOffset` takes. Returns `undefined` when the output does not hold the sat.
 */
export function findSatOffset(
  satRanges: ReadonlyArray<readonly [number, number]>,
  sat: number,
): number | undefined {
  if (!Number.isSafeInteger(sat) || sat < 0) {
    throw new Error(`sat must be a non-negative safe integer; got ${sat}`);
  }
  let offset = 0;
  for (const [start, end] of satRanges) {
    if (start <= sat && sat < end) return offset + (sat - start);
    offset += end - start;
  }
  return undefined;
}

/**
 * Whether a chosen sat needs a padding coin, and how many sats short it is.
 *
 * A sat that sits partway into its coin leaves the sats before it as their
 * own output, and Bitcoin will not relay that output below the dust limit of
 * the address it goes to. ord handles this by pulling in a further wallet
 * input to pad it; the SDK takes that coin as `paddingUtxo`. This answers the
 * question up front, so a screen can ask for the second coin instead of
 * discovering the need from a failed build (the builder's own check throws
 * `sat-offset-needs-padding` with the same numbers).
 *
 * `paddingAddress` is where that padding output goes, and it is NOT always
 * the payment address:
 *   - sat in its own coin (`satTarget` kind `in-utxo`, ord's
 *     `--satpoint <other utxo>:<offset>`): that coin's OWN address, since its
 *     other sats go back where they came from.
 *   - sat inside the funding coin (kind `in-funding`): the payment address,
 *     which is where the funding coin's change goes.
 *
 * An offset of 0 never needs padding: the sat is the coin's first sat, so
 * there is nothing before it to pay out.
 */
export function satPaddingRequirement(
  satOffset: number,
  paddingAddress: string,
): { needsPadding: boolean; shortfallSats: number; dustLimitSats: number } {
  if (!Number.isInteger(satOffset) || satOffset < 0) {
    throw new Error(`satOffset must be a non-negative integer; got ${satOffset}`);
  }
  const dustLimitSats = getMinimumUtxoSize(paddingAddress);
  const needsPadding = satOffset > 0 && satOffset < dustLimitSats;
  return {
    needsPadding,
    shortfallSats: needsPadding ? dustLimitSats - satOffset : 0,
    dustLimitSats,
  };
}
