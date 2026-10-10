"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EFFECT_AFTER_CLICK_PROBE_MS = void 0;
exports.clickUntilEffect = clickUntilEffect;
const click_until_effect_core_1 = require("./click-until-effect-core");
/**
 * Probe: how long one click gets to produce the effect before the control is
 * inspected for a swallowed click. Long enough for a render after a click on a
 * loaded CI runner, short enough to re-click within the test.
 */
exports.EFFECT_AFTER_CLICK_PROBE_MS = 5_000;
/**
 * Click `control` until `effect` is visible. Returns how many clicks it took,
 * so a caller can log or assert that a surface needed only one.
 */
async function clickUntilEffect(control, effect, options = {}) {
    return (0, click_until_effect_core_1.clickUntilEffectWithProbe)(control, effect, options, exports.EFFECT_AFTER_CLICK_PROBE_MS);
}
//# sourceMappingURL=click-until-effect.js.map