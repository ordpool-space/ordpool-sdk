"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clickUntilEffect = clickUntilEffect;
/**
 * Click `control` until `effect` is visible. Returns how many clicks it took,
 * so a caller can log or assert that a surface needed only one.
 */
async function clickUntilEffect(control, effect, options = {}) {
    const maxClicks = options.maxClicks ?? 3;
    const settleMs = options.settleMs ?? 5_000;
    const label = options.label ?? String(control);
    let clicks = 0;
    let lastState = 'not observed';
    while (clicks < maxClicks) {
        await control.click();
        clicks++;
        try {
            await effect.waitFor({ state: 'visible', timeout: settleMs });
            return { clicks };
        }
        catch {
            // The effect has not appeared yet. Whether that means the click was
            // swallowed or merely that the work is slow is answered by the control.
            const visible = await control.isVisible().catch(() => false);
            const enabled = visible ? await control.isEnabled().catch(() => false) : false;
            lastState = `visible=${visible} enabled=${enabled}`;
            if (visible && enabled)
                continue;
            // The control reacted, so the click registered. Give the effect the rest
            // of the budget rather than sending a second one.
            await effect.waitFor({ state: 'visible', timeout: settleMs });
            return { clicks };
        }
    }
    throw new Error(`clickUntilEffect: ${label} was clicked ${clicks} time(s) and the effect never became visible ` +
        `(control after the last click: ${lastState}). ` +
        'A control that stays visible and enabled after a click is the swallowed-click signature; ' +
        'one that goes disabled or disappears means the click registered and the effect itself never arrived.');
}
//# sourceMappingURL=click-until-effect.js.map