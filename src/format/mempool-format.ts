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
 *
 * **Prefer {@link addressVerificationChunks} whenever the reader might also
 * COPY the address**, which is any address they are asked to send to. This
 * function puts real space characters in the text, so a reader who drags a
 * selection across it instead of pressing the copy button gets an address
 * their wallet will reject.
 */
export function groupAddressForVerification(address: string): string {
  return (address.match(/.{1,4}/g) ?? []).join(GROUP);
}

/**
 * The same four-character grouping, as chunks to render in their own
 * elements with the gaps drawn in CSS.
 *
 *   ["bc1p", "utuz", ...]  ->  <span>bc1p</span><span>utuz</span>...
 *
 * Use this for an address the reader is asked to SEND to, where they will
 * verify it AND copy it. Because no space character exists in the DOM, a
 * dragged selection yields the raw address, so manual copy and the copy
 * button agree.
 *
 * Two constraints, both load-bearing and both invisible in the markup:
 *
 * - **Space the chunks with `margin`, never `word-spacing`.** There are no
 *   space characters left for `word-spacing` to widen, so it does nothing.
 *   And never put a space back in.
 * - **Keep the chunks `display: inline`.** The browser's copy serialiser
 *   inserts line breaks by LAYOUT, not by text nodes, so chunks laid out as
 *   flex or grid items can reach the clipboard newline-separated even though
 *   the DOM holds no whitespace at all.
 *
 * That second one also decides how to verify this: select and copy in a real
 * browser and compare. `textContent` reports the raw address either way, so
 * it cannot see the defect.
 *
 * Grouping a send-address is worth this much care because the reader's task
 * is genuinely both: they compare it against what their own wallet shows,
 * and then they paste it somewhere. Serving only the second is how the
 * unreadable-run-of-62-characters problem came back.
 */
export function addressVerificationChunks(address: string): string[] {
  return address.match(/.{1,4}/g) ?? [];
}
