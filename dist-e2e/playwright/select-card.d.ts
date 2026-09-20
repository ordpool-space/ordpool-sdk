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
 * carries. When it carries NONE, this degrades to exactly one click, which is
 * the behaviour it replaces: a harness must not invent a marker it cannot
 * observe and then wait for it.
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
}
export declare function selectCard(card: SelectableCard, opts?: {
    maxClicks?: number;
    settleMs?: number;
}): Promise<SelectCardResult>;
//# sourceMappingURL=select-card.d.ts.map