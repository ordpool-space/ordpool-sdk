/**
 * The one clause that says what the ordpool family does for a coin before
 * spending it.
 *
 * Used by {@link singleAddressCaveat} only. The family footer's lede used to
 * carry it too, which is why this is a standalone constant, and no longer
 * does: a footer introduces the family, and opening it with a caution about
 * coins being spent frightens everyone to warn the few who need it. The
 * warning belongs at the action, where the person can act on it.
 *
 * Deliberately a fragment, not a sentence, so a caller supplies its own
 * subject ("everything in the ordpool family").
 */
export const COIN_CHECK_PROMISE = 'checks what a coin is carrying before it spends it';
