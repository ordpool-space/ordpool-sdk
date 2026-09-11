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
