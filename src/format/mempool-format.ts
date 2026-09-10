/**
 * Number and identifier formatting, matching what mempool already does.
 *
 * ordpool.space is a mempool fork: its pages mix upstream components with
 * ours, so a format we invent here would read as an inconsistency inside a
 * single page and would fight every upstream merge. These functions encode
 * UPSTREAM's conventions rather than a house style, and the three non-fork
 * consumers adopt them to match.
 *
 * Where upstream is itself inconsistent, that is documented per function
 * rather than quietly resolved.
 */

/** Upstream groups Bitcoin amounts with a space, never a locale separator. */
const GROUP = ' ';

/**
 * A BTC amount, grouped exactly as mempool's `bitcoinsatoshis` pipe does:
 * eight decimals, the integer part grouped in threes from the right, and
 * the fraction grouped as 2 + 3 + 3.
 *
 *   0.00299046  ->  "0.00 299 046"
 *   1234.5      ->  "1 234.50 000 000"
 *
 * The pipe additionally dims the leading zeros in its own markup. That is
 * presentation, not format, so it stays with the consumer.
 */
export function formatBitcoinAmount(btc: number | string): string {
  const fixed = (typeof btc === 'string' ? parseFloat(btc || '0') : btc).toFixed(8);
  const [whole, fraction] = fixed.split('.');
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  const groupedFraction = `${fraction.slice(0, 2)}${GROUP}${fraction.slice(2, 5)}${GROUP}${fraction.slice(5)}`;
  return `${groupedWhole}.${groupedFraction}`;
}

/**
 * A whole number of sats, grouped in threes with a space.
 *
 *   1234567  ->  "1 234 567"
 *
 * **Upstream is inconsistent here and this follows the safer half.** mempool
 * groups BTC amounts with a space (`bitcoinsatoshis`, above) but renders raw
 * sat counts through Angular's `number` pipe, which uses the ACTIVE LOCALE.
 * On a German locale that yields "21.000", which an English reader takes for
 * twenty-one: a spending prompt wrong by three orders of magnitude, and the
 * exact defect this ecosystem shipped and then fixed in cat21-wallet.
 *
 * A space cannot be read as a decimal point in any locale, and it is already
 * upstream's choice for the other Bitcoin amount, so it is the one grouping
 * that is both faithful and unambiguous.
 *
 * **Not for ordpool.space.** The fork already renders sats through Angular's
 * `number` pipe, which IS mempool's convention there, and it builds
 * single-locale English, so the locale ambiguity this guards against cannot
 * arise. Swapping would buy nothing and would move the fork away from
 * upstream, which is the opposite of why these helpers exist. The test is not
 * "do we own this screen" but "does an upstream equivalent already render
 * here": if one does, use it.
 */
export function formatSats(sats: number | bigint): string {
  const negative = sats < 0;
  const digits = (negative ? -sats : sats).toString();
  return (negative ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
}

/**
 * Shorten a txid, address or inscription id for display, matching mempool's
 * `shortenString` pipe: half the budget from each end, an ellipsis between.
 *
 *   shortenId('bc1putuz...jqmkc0pg', 12)  ->  "bc1put...mkc0pg"
 *
 * **Not for ordpool.space's templates.** The fork HAS this as an Angular pipe
 * (`| shortenString`), which is the upstream-native affordance and is
 * byte-identical to this. Importing this function there would replace an
 * upstream idiom with a reproduction of it. Use it where there is no such
 * pipe, or in TypeScript rather than a template.
 *
 * **Not for a value someone is committing to.** An address on an approval
 * screen is shown in full when the reader has something to compare it
 * against, because truncation displays exactly the characters a poisoned
 * lookalike is built to match and hides the ones that would expose it. Use
 * this for references a reader scans or clicks, not for the destination of
 * their money.
 */
export function shortenId(value: string, length = 12): string {
  if (!value) return '';
  if (value.length <= length) return value;
  const half = Math.floor(length / 2);
  return `${value.substring(0, half)}...${value.substring(value.length - half)}`;
}

/**
 * Group an address into four-character blocks so a reader can compare it
 * chunk by chunk instead of character by character.
 *
 *   "bc1putuz..." -> "bc1p utuz ..."
 *
 * The counterpart to {@link shortenId}: this is what a full address gets when
 * it IS the thing being verified. Grouping is display only; strip the spaces
 * before the value reaches a signer.
 */
export function groupAddressForVerification(address: string): string {
  return (address.match(/.{1,4}/g) ?? []).join(GROUP);
}
