"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectCard = selectCard;
const SELECTED_MARKERS = ['aria-checked', 'aria-selected', 'data-selected', 'data-active'];
async function readSelected(card) {
    for (const name of SELECTED_MARKERS) {
        const v = await card.getAttribute(name).catch(() => null);
        if (v !== null)
            return v === 'true' || v === '';
    }
    const cls = await card.getAttribute('class').catch(() => null);
    if (cls !== null)
        return /\b(selected|active|checked)\b/.test(cls);
    return undefined;
}
async function selectCard(card, opts = {}) {
    const maxClicks = opts.maxClicks ?? 3;
    const settleMs = opts.settleMs ?? 400;
    for (let clicks = 1; clicks <= maxClicks; clicks++) {
        await card.click();
        await new Promise((r) => setTimeout(r, settleMs));
        const selected = await readSelected(card);
        if (selected === undefined)
            return { clicks, observable: false };
        if (selected)
            return { clicks, observable: true };
    }
    return { clicks: maxClicks, observable: true };
}
//# sourceMappingURL=select-card.js.map