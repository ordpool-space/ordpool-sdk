/**
 * `ordpool-sdk/rune` — rendering a rune balance the way ord renders it.
 *
 * Its own subpath because a consumer asserting a rune LABEL needs the string
 * and nothing else. Both barrels reach the wallet connectors, so `/core` and
 * `ordpool-sdk` drag the same third-party set (sats-connect, axios, base58-js
 * and the rest) into a test that only wants "1000 @". That cost is what makes
 * a spec reach into `dist/` by filesystem path instead, which bypasses the
 * exports map and breaks whenever the build's shape changes.
 *
 * `formatRunePile` matters more than it looks: ord's own `Display for Pile`
 * strips trailing zeros and puts a NON-BREAKING space before the symbol, so
 * rendering a rune row by hand makes every row disagree with the explorer it
 * links to.
 */
export {
  formatRuneAmount,
  formatRunePile,
  MAX_RUNE_DIVISIBILITY,
  RUNE_SYMBOL_SEPARATOR,
  RUNE_SYMBOL_FALLBACK,
} from '../cat21-mint/rune-amount.js';
