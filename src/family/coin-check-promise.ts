/**
 * The one clause that says what the ordpool family does for a coin before
 * spending it.
 *
 * It appears in two places a reader can meet in one session: the family
 * footer's opening line, and the single-address note beside a mint. Those are
 * the same promise, so they are the same string. Two hand-written versions
 * would let the footer advertise a property the warning describes
 * differently, which reads worse than either saying nothing.
 *
 * Deliberately a fragment, not a sentence: each caller supplies its own
 * subject ("everything here", "everything in the ordpool family"), because
 * the sentence around it differs while the claim does not.
 */
export const COIN_CHECK_PROMISE = 'checks what a coin is carrying before it spends it';
