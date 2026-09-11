/**
 * The two strings on the way into a wallet, which read the same on every
 * site.
 *
 * Hosted here for the opposite reason a site's tagline is NOT: a tagline is
 * meant to differ per site, so it belongs to its repo. These are meant to be
 * IDENTICAL everywhere, and a reader who connects on cat21.space and then on
 * cubes should meet the same two words, not two attempts at them. One string,
 * one place.
 *
 * The ICON is explicitly NOT here. Each site draws its own, in its own set:
 * ordpool.space from its existing icons, cat21.space something pixelated,
 * cubes whatever suits it. A shared SVG would fight three design languages to
 * save nothing, because nobody reads an icon across two sites and notices it
 * differs.
 */

/**
 * The button that opens the picker. A wallet icon sits beside it, drawn by
 * the site.
 *
 * Just the verb: the icon already says "wallet", and repeating the noun in
 * the label makes the control wider for no added meaning. The long form
 * belongs on the panel it opens, where {@link CONNECT_PANEL_HEADING} says it
 * in full.
 */
export const CONNECT_BUTTON_LABEL = 'Connect';

/**
 * The heading of the panel the button opens.
 *
 * Says the noun the button omits, so the two read as one sentence across the
 * click: "Connect" then "Connect a wallet". "a wallet" rather than "your
 * wallet" because at this point we do not know that they have one; the panel
 * also offers installing.
 */
export const CONNECT_PANEL_HEADING = 'Connect a wallet';

/**
 * The accessible name of the connect button.
 *
 * A screen reader meets the label without the icon beside it, so the bare
 * verb loses the noun the icon was carrying. This restores it.
 */
export const CONNECT_BUTTON_ACCESSIBLE_NAME = 'Connect a wallet';
