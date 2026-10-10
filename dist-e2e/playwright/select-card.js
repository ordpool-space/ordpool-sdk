"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CARD_SELECT_PROBE_MS = void 0;
exports.selectCard = selectCard;
const SELECTED_MARKERS = ['aria-checked', 'aria-selected', 'data-selected', 'data-active'];
async function readSelected(card) {
    for (const name of SELECTED_MARKERS) {
        const v = await card.getAttribute(name).catch(() => null);
        if (v !== null)
            return v === 'true' || v === '';
    }
    const cls = await card.getAttribute('class').catch(() => null);
    // An EMPTY class is the absence of a marker, not a report of "not
    // selected". Reading it as false makes this helper claim a state it never
    // observed, which is the instrument-lies failure it exists to prevent, and
    // it spends the full click budget on every healthy run. UniSat's
    // address-type cards are exactly this shape: `class=""`, with selection
    // carried by an inline background colour that no standard marker exposes.
    if (cls !== null && cls.trim() !== '')
        return /\b(selected|active|checked)\b/.test(cls);
    return undefined;
}
/**
 * Probe: how long after a click the selected marker is read. A card may carry
 * no marker at all (UniSat), so there is no state to wait on; long enough for
 * the re-render after the click, short enough to re-click a swallowed one.
 */
exports.CARD_SELECT_PROBE_MS = 400;
async function selectCard(card, opts = {}) {
    const maxClicks = opts.maxClicks ?? 3;
    let selected;
    let observable = true;
    for (let clicks = 1; clicks <= maxClicks; clicks++) {
        await card.click();
        await new Promise((r) => setTimeout(r, exports.CARD_SELECT_PROBE_MS));
        selected = await readSelected(card);
        if (selected === undefined) {
            // No marker to read. Keep clicking anyway: selecting a card is
            // idempotent, and the retry is the part that works. Returning here
            // would hand back a single click, which is the swallowed-click bug.
            observable = false;
            continue;
        }
        if (selected)
            return { clicks, observable: true, selected };
    }
    return { clicks: maxClicks, observable, selected };
}
//# sourceMappingURL=select-card.js.map