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
 * @param amount Base units, in any of the shapes ord's JSON uses. `/output/`
 *               emits the amount as a JSON NUMBER, `/address/` as a STRING, so
 *               both are accepted along with a bigint. A caller converting a
 *               number itself must use `BigInt(n)`, never `String(n)`:
 *               `String(1e21)` is `"1e+21"`, which is refused, and the amount
 *               would vanish from the row.
 *
 *               A number above `Number.MAX_SAFE_INTEGER` may ALREADY be
 *               approximate, because ord emits a u128 as a JSON number and the
 *               rounding happens in `JSON.parse` before any of this runs.
 *               Nothing here can recover those digits; read such a balance
 *               from a string source (`/address/`) when it matters.
 * @param divisibility Decimal places, 0 to {@link MAX_RUNE_DIVISIBILITY}.
 */
export function formatRuneAmount(amount: string | number | bigint, divisibility: number): string {
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

/** Parse base units without ever introducing a JS number of our own. */
function toBaseUnits(amount: string | number | bigint): bigint {
  if (typeof amount === 'bigint') {
    if (amount < 0n) throw new Error(`a rune amount cannot be negative; got ${amount}`);
    return amount;
  }
  if (typeof amount === 'number') {
    // A fraction here means something upstream already corrupted the value, so
    // it is refused rather than rounded into a plausible-looking balance.
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error(`a rune amount must be a non-negative integer; got ${amount}`);
    }
    return BigInt(amount);
  }
  const text = amount.trim();
  // BigInt() accepts "0x…" and "" and would quietly turn them into something
  // else; a rune amount is plain decimal digits.
  if (!/^\d+$/.test(text)) {
    throw new Error(`a rune amount must be decimal base units; got ${JSON.stringify(amount)}`);
  }
  return BigInt(text);
}

/** A rune balance as ord's `/output/` reports it. */
export interface RunePile {
  /** Base units, as ord emits them: a number on `/output/`, a string on `/address/`. */
  amount: string | number | bigint;
  /** Decimal places, 0 to {@link MAX_RUNE_DIVISIBILITY}. */
  divisibility: number;
  /** The rune's symbol. Absent for a rune that has none. */
  symbol?: string | null;
}

/**
 * ord separates the figure from the symbol with U+00A0, a NON-BREAKING space,
 * so a rune amount never wraps away from its symbol.
 */
export const RUNE_SYMBOL_SEPARATOR = '\u00A0';

/** What ord shows for a rune with no symbol: the generic currency sign. */
export const RUNE_SYMBOL_FALLBACK = '\u00A4';

/**
 * Render a rune balance complete with its symbol, exactly as ord's `Pile`
 * display does: the figure, a NON-BREAKING space, then the symbol, or `¤`
 * when the rune has none.
 *
 * This is ord's whole rendering. `Pile`'s `Display` writes the symbol
 * unconditionally in the same function, so ord never shows the figure on its
 * own; {@link formatRuneAmount} is the unusual case and this is the normal
 * one. Prefer this wherever a row sits next to an explorer that renders the
 * same balance.
 *
 * The separator being invisible is the reason it lives here: a caller typing
 * an ordinary space looks identical in review and behaves differently at a
 * line break.
 */
export function formatRunePile(pile: RunePile): string {
  const symbol = pile.symbol === undefined || pile.symbol === null || pile.symbol === ''
    ? RUNE_SYMBOL_FALLBACK
    : pile.symbol;
  return `${formatRuneAmount(pile.amount, pile.divisibility)}${RUNE_SYMBOL_SEPARATOR}${symbol}`;
}
