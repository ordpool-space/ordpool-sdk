/**
 * The Ordpool family: the four things we ship, and the one sentence each
 * of them gets.
 *
 * Hosted here because four surfaces render these lines (the family footer on
 * ordpool.space, cat21.space and cubes, plus CAT-21 wallet's own positioning
 * slot) and a sentence copied into four repos is a sentence that says four
 * slightly different things a month later. Read them; do not retype them.
 *
 * The lines are the maintainer's own words, kept verbatim, including the
 * capital C in "Creator of Ordpool", which reads as a signature rather than
 * a title.
 */

/** What the family block calls itself. */
export const ORDPOOL_FAMILY_HEADING = 'The Ordpool family';

/**
 * There is deliberately NO lede here.
 *
 * The opening sentence under the heading is each site's OWN copy, written and
 * formatted in its own repo, because its second half names what THAT site
 * renders and a tagline for a product belongs with the product. The schema
 * every site follows is two lines:
 *
 *   Sometimes Bitcoin is hard money.
 *   Sometimes Bitcoin is <this site's own tail>.
 *
 * What stays shared is what every site prints about EVERY member: the heading
 * and {@link ORDPOOL_FAMILY}. Those describe the other three as much as
 * yourself, so one copy of them is what keeps the family consistent. A site's
 * own tagline describes only itself, so hosting it here bought nothing and
 * put the SDK in the way of a repo editing its own voice.
 */

/**
 * What CAT-21 wallet adds to its own copy, having no footer to put a lede in.
 *
 * The wallet says what it is; this says where the rest of the story lives.
 */
export const CAT21_LORE_POINTER = 'See cat21.space for the whole cat lore.';

/** One member of the family, as a footer or a link list renders it. */
export interface OrdpoolFamilyMember {
  /** Stable key, for a consumer marking its own row "You are here". */
  key: 'ordpool' | 'cat21' | 'cubes' | 'wallet';
  /** How the row names itself. A domain, except the wallet, which has none. */
  name: string;
  /** Where the row links. */
  url: string;
  /** The one sentence. A claim, not a caption. */
  line: string;
}

/**
 * In this order, which is the order they were built.
 *
 * A consumer renders every member INCLUDING itself, and marks its own row as
 * the current site rather than dropping it: a family of four that shows three
 * from every vantage point never lets a reader see the whole set.
 */
export const ORDPOOL_FAMILY: readonly OrdpoolFamilyMember[] = [
  {
    key: 'ordpool',
    name: 'ordpool.space',
    url: 'https://ordpool.space',
    line: "A Bitcoin MEMEpool explorer. If it's on Bitcoin, we display it. No judgements!",
  },
  {
    key: 'cat21',
    name: 'cat21.space',
    url: 'https://cat21.space',
    line: 'Everything CAT-21, a meme protocol from the Creator of Ordpool.',
  },
  {
    key: 'cubes',
    name: 'cubes.haushoppe.art',
    url: 'https://cubes.haushoppe.art',
    line: 'Everything cubes, an art project from the Creator of Ordpool.',
  },
  {
    key: 'wallet',
    name: 'CAT-21 wallet',
    url: 'https://github.com/ordpool-space/cat21-wallet',
    line: 'A hot wallet for high frequency trading of CAT-21, made for AI agents and their humans.',
  },
] as const;

/**
 * CAT-21 wallet's own positioning line, which is its family line and not a
 * second sentence written to sit beside it.
 *
 * The wallet needs a line that says what it is FOR, distinct from the safety
 * disclosure that says what it does not watch. This is that line, and it
 * already exists: writing a different one for the wallet's own screen would
 * mean the family footer and the wallet describe the same product in two
 * voices, which is the drift this module exists to prevent.
 */
export const CAT21_WALLET_POSITIONING = ordpoolFamilyMember('wallet').line;

/** The family member a consumer is currently rendering inside, or undefined. */
export function ordpoolFamilyMember(key: OrdpoolFamilyMember['key']): OrdpoolFamilyMember {
  const found = ORDPOOL_FAMILY.find(m => m.key === key);
  if (!found) throw new Error(`Unknown Ordpool family member: ${key}`);
  return found;
}
