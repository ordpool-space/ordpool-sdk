/**
 * Click a selection card until it REPORTS selected.
 *
 * A card in a list of address types is a click on a control whose siblings
 * re-render on selection, so the click can be swallowed exactly like any
 * other (E2E_BEST_PRACTICES, "a single click on a control that re-renders").
 * The manifestation here is worse than a missing element: nothing fails at
 * the click, onboarding continues with the DEFAULT card still selected, and
 * the failure surfaces much later as a wallet on the wrong address type. A
 * spec then reports a wrong ADDRESS, which reads as a derivation bug.
 *
 * Re-clicking is safe because selecting a card is idempotent: the second
 * click selects the same card, unlike a toggle, whose second click reverses
 * the first.
 *
 * The selected state is read from whichever standard marker the control
 * carries. When it carries NONE, the clicking still runs to the cap and the
 * result says `observable: false`: the retry is what makes the selection
 * take, and reading it back is a separate question from performing it. What a
 * harness must not do is CLAIM a state it cannot observe, which is why
 * `selected` stays `undefined` there rather than becoming `true`.
 *
 * UniSat's address-type cards are that case: `class=""`, selection carried by
 * an inline background colour. One click leaves the DEFAULT card selected and
 * the wallet lands on the wrong address type.
 */
export interface SelectableCard {
    click: (opts?: {
        timeout?: number;
    }) => Promise<void>;
    getAttribute: (name: string) => Promise<string | null>;
}
export interface SelectCardResult {
    clicks: number;
    /** False when the control carries no readable selected-state marker. */
    observable: boolean;
    /**
     * What the LAST read actually said. At the click cap this is the honest
     * answer rather than an assumption: a helper that reports a state it never
     * observed is the instrument-lies failure it exists to prevent.
     */
    selected: boolean | undefined;
}
export declare function selectCard(card: SelectableCard, opts?: {
    maxClicks?: number;
    settleMs?: number;
}): Promise<SelectCardResult>;
//# sourceMappingURL=select-card.d.ts.map