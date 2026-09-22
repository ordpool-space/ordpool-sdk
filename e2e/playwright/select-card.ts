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
  let observable = true;
  for (let clicks = 1; clicks <= maxClicks; clicks++) {
    await card.click();
    await new Promise((r) => setTimeout(r, settleMs));
    selected = await readSelected(card);
    if (selected === undefined) {
      // No marker to read. Keep clicking anyway: selecting a card is
      // idempotent, and the retry is the part that works. Returning here
      // would hand back a single click, which is the swallowed-click bug.
      observable = false;
      continue;
    }
    if (selected) return { clicks, observable: true, selected };
  }
  return { clicks: maxClicks, observable, selected };
}
