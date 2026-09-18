"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isVisibleWithin = isVisibleWithin;
/**
 * Resolves `true` if the element becomes visible within `timeoutMs`, `false` if
 * it does not. Never throws for absence.
 */
async function isVisibleWithin(locator, timeoutMs) {
    try {
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=is-visible-within.js.map