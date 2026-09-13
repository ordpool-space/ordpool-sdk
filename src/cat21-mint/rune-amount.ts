/**
 * A rune balance in base units, rendered the way ord renders it.
 *
 * ord's `/output/` reports a rune amount in BASE units together with the
 * rune's divisibility, so the displayed figure is `amount / 10^divisibility`.
 * The amount is a u128 and routinely exceeds `Number.MAX_SAFE_INTEGER`, so the
 * conversion has to stay in BigInt from end to end: parsing it into a JS number
 * anywhere on the way silently rounds a holder's balance.
 *
 * The formatting is not a free choice. It mirrors ord's `Pile` display
 * (`crates/ordinals/src/pile.rs`) exactly, and is pinned by ord's own test
 * vectors, so three consumers rendering the same row cannot drift from each
 * other or from the explorer.
 */

/** ord's ceiling on a rune's divisibility (`Etching::MAX_DIVISIBILITY`). */
export const MAX_RUNE_DIVISIBILITY = 38;

/**
 * Render `amount` base units of a rune with `divisibility` decimal places,
 * as ord does.
 *
 * ord drops a zero fraction and strips trailing zeros from a non-zero one, so
 * the output is the shortest exact form: 100 at divisibility 2 is `"1"`, not
 * `"1.00"`, and 1100 at divisibility 3 is `"1.1"`, not `"1.100"`. It never
 * rounds and never uses exponent notation.
 *
 * Digit grouping is deliberately not applied; that is the caller's
 * presentation choice. ord pairs the figure with the rune's symbol separated
 * by a NON-BREAKING space (U+00A0), falling back to the currency sign `¤` when
 * a rune has no symbol, if a caller wants ord's complete rendering.
 *
 * @param amount Base units. A string (as ord's JSON carries it) or a bigint.
 *               Never pass a `number` that came from `JSON.parse`: by then the
 *               value may already have been rounded.
 * @param divisibility Decimal places, 0 to {@link MAX_RUNE_DIVISIBILITY}.
 */
export function formatRuneAmount(amount: string | bigint, divisibility: number): string {
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > MAX_RUNE_DIVISIBILITY) {
    throw new Error(`divisibility must be an integer 0..${MAX_RUNE_DIVISIBILITY}; got ${divisibility}`);
  }
  const base = toBaseUnits(amount);

  if (divisibility === 0) return base.toString();

  const cutoff = 10n ** BigInt(divisibility);
  const whole = base / cutoff;
  const fractional = base % cutoff;
  if (fractional === 0n) return whole.toString();

  // Left-pad to the full width so 6 at divisibility 3 is ".006", then strip
  // the trailing zeros ord strips.
  const padded = fractional.toString().padStart(divisibility, '0').replace(/0+$/, '');
  return `${whole}.${padded}`;
}

/** Parse base units without ever going through a JS number. */
function toBaseUnits(amount: string | bigint): bigint {
  if (typeof amount === 'bigint') {
    if (amount < 0n) throw new Error(`a rune amount cannot be negative; got ${amount}`);
    return amount;
  }
  const text = amount.trim();
  // BigInt() accepts "0x…" and "" and would quietly turn them into something
  // else; a rune amount is plain decimal digits.
  if (!/^\d+$/.test(text)) {
    throw new Error(`a rune amount must be decimal base units; got ${JSON.stringify(amount)}`);
  }
  return BigInt(text);
}
