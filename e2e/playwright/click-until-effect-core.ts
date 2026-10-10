/**
 * The loop behind `clickUntilEffect` and `clickUntilApprovalPopup`, with the
 * probe duration as a parameter. Not part of the `ordpool-sdk/e2e` surface:
 * a probe duration is a named constant inside an SDK helper (TESTING.md), never
 * a value a spec passes.
 */
import type {
  ClickableControl,
  ClickUntilEffectOptions,
  ClickUntilEffectResult,
  EffectLocator,
} from './click-until-effect';

export async function clickUntilEffectWithProbe(
  control: ClickableControl,
  effect: EffectLocator,
  options: ClickUntilEffectOptions,
  probeMs: number,
): Promise<ClickUntilEffectResult> {
  const maxClicks = options.maxClicks ?? 3;
  const label = options.label ?? String(control);

  let clicks = 0;
  let lastState = 'not observed';

  while (clicks < maxClicks) {
    await control.click();
    clicks++;

    try {
      await effect.waitFor({ state: 'visible', timeout: probeMs });
      return { clicks };
    } catch {
      // The effect has not appeared within the probe. Whether that means the
      // click was swallowed or merely that the work is slow is answered by the
      // control.
      let preClick: boolean;
      if (options.stillPreClick) {
        preClick = await options.stillPreClick().catch(() => false);
        lastState = `stillPreClick=${preClick}`;
      } else {
        const visible = await control.isVisible().catch(() => false);
        const enabled = visible ? await control.isEnabled().catch(() => false) : false;
        preClick = visible && enabled;
        lastState = `visible=${visible} enabled=${enabled}`;
      }

      if (preClick) continue;

      // The control reacted, so the click registered. Wait for the effect
      // under the runner config's bound rather than sending a second click,
      // and say which of the two hypotheses held if it still never arrives.
      try {
        await effect.waitFor({ state: 'visible' });
        return { clicks };
      } catch {
        throw new Error(
          `clickUntilEffect: ${label} reacted to the click (${lastState}) and the effect never became ` +
            'visible. The click registered; the effect itself never arrived, so the defect is downstream ' +
            'of the control rather than a swallowed click.',
        );
      }
    }
  }

  throw new Error(
    `clickUntilEffect: ${label} was clicked ${clicks} time(s) and the effect never became visible ` +
      `(control after the last click: ${lastState}). ` +
      'A control still in its pre-click state after a click is the swallowed-click signature; ' +
      'one that reacted means the click registered and the effect itself never arrived.',
  );
}
