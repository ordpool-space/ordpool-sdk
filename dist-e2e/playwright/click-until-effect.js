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
            let preClick;
            if (options.stillPreClick) {
                preClick = await options.stillPreClick().catch(() => false);
                lastState = `stillPreClick=${preClick}`;
            }
            else {
                const visible = await control.isVisible().catch(() => false);
                const enabled = visible ? await control.isEnabled().catch(() => false) : false;
                preClick = visible && enabled;
                lastState = `visible=${visible} enabled=${enabled}`;
            }
            if (preClick)
                continue;
            // The control reacted, so the click registered. Give the effect the rest
            // of the budget rather than sending a second one, and say which of the two
            // hypotheses held if it still never arrives.
            try {
                await effect.waitFor({ state: 'visible', timeout: settleMs });
                return { clicks };
            }
            catch {
                throw new Error(`clickUntilEffect: ${label} reacted to the click (${lastState}) and the effect never became ` +
                    'visible. The click registered; the effect itself never arrived, so the defect is downstream ' +
                    'of the control rather than a swallowed click.');
            }
        }
    }
    throw new Error(`clickUntilEffect: ${label} was clicked ${clicks} time(s) and the effect never became visible ` +
        `(control after the last click: ${lastState}). ` +
        'A control still in its pre-click state after a click is the swallowed-click signature; ' +
        'one that reacted means the click registered and the effect itself never arrived.');
}
//# sourceMappingURL=click-until-effect.js.map