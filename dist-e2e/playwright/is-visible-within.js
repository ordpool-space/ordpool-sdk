"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isVisibleWithin = isVisibleWithin;
/**
 * Resolves `true` if the element becomes visible within `probeMs`, `false` if
 * it does not. Never throws for absence.
 */
async function isVisibleWithin(locator, probeMs) {
    try {
        await locator.waitFor({ state: 'visible', timeout: probeMs });
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=is-visible-within.js.map