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
  click: (opts?: { timeout?: number }) => Promise<void>;
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

const SELECTED_MARKERS = ['aria-checked', 'aria-selected', 'data-selected', 'data-active'] as const;

async function readSelected(card: SelectableCard): Promise<boolean | undefined> {
  for (const name of SELECTED_MARKERS) {
    const v = await card.getAttribute(name).catch(() => null);
    if (v !== null) return v === 'true' || v === '';
  }
  const cls = await card.getAttribute('class').catch(() => null);
  // An EMPTY class is the absence of a marker, not a report of "not
  // selected". Reading it as false makes this helper claim a state it never
  // observed, which is the instrument-lies failure it exists to prevent, and
  // it spends the full click budget on every healthy run. UniSat's
  // address-type cards are exactly this shape: `class=""`, with selection
  // carried by an inline background colour that no standard marker exposes.
  if (cls !== null && cls.trim() !== '') return /\b(selected|active|checked)\b/.test(cls);
  return undefined;
}

export async function selectCard(
  card: SelectableCard,
  opts: { maxClicks?: number; settleMs?: number } = {},
): Promise<SelectCardResult> {
  const maxClicks = opts.maxClicks ?? 3;
  const settleMs = opts.settleMs ?? 400;

  let selected: boolean | undefined;
  for (let clicks = 1; clicks <= maxClicks; clicks++) {
    await card.click();
    await new Promise((r) => setTimeout(r, settleMs));
    selected = await readSelected(card);
    if (selected === undefined) return { clicks, observable: false, selected };
    if (selected) return { clicks, observable: true, selected };
  }
  return { clicks: maxClicks, observable: true, selected };
}
