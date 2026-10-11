/**
 * @test-kind unit
 * Real:   waitForControlUnlockingIfAsked
 * Faked:  the popup page (getByTestId) and the control (waitFor), shapes from @playwright/test's Locator; each
 *         visibility is a promise the test settles. Testids from Cat21 Wallet 1178faf's SettingsSelectors
 * Proves: a popup that shows its control is left alone; a popup that booted locked gets the password typed and
 *         unlocked before the control is awaited; a failure before either showed fails; the loser of a decided
 *         race does not
 */
import { LEATHER_UNLOCK_BUTTON, LEATHER_UNLOCK_PASSWORD_INPUT, waitForControlUnlockingIfAsked } from './leather-unlock';

/** A visibility the test resolves or rejects; every `waitFor` call sees the current one. */
function visibility() {
  let resolve: () => void = () => undefined;
  let reject: (e: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  const waits: number[] = [];
  return {
    waitFor: () => { waits.push(1); return promise; },
    show: () => resolve(),
    fail: (e: Error) => reject(e),
    waits,
  };
}

function fakePopup() {
  const steps: string[] = [];
  const input = visibility();
  const page = {
    getByTestId: (id: string) => ({
      waitFor: () => (id === LEATHER_UNLOCK_PASSWORD_INPUT ? input.waitFor() : new Promise<void>(() => undefined)),
      fill: async (value: string) => { steps.push(`fill ${id} ${value}`); },
      click: async () => { steps.push(`click ${id}`); },
    }),
  };
  return { page, input, steps };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('waitForControlUnlockingIfAsked', () => {
  it('answers shown and types nothing when the control shows', async () => {
    const popup = fakePopup();
    const control = visibility();
    const result = waitForControlUnlockingIfAsked(popup.page, control, 'pw');
    control.show();
    expect(await result).toBe('shown');
    expect(popup.steps).toEqual([]);
  });

  it('unlocks a popup that booted locked, then waits for the control', async () => {
    const popup = fakePopup();
    const control = visibility();
    const result = waitForControlUnlockingIfAsked(popup.page, control, 'correct-horse');
    popup.input.show();
    await settle();
    expect(popup.steps).toEqual([`fill ${LEATHER_UNLOCK_PASSWORD_INPUT} correct-horse`, `click ${LEATHER_UNLOCK_BUTTON}`]);
    control.show();
    expect(await result).toBe('unlocked');
    expect(control.waits.length).toBe(2);
  });

  it('fails when a wait fails before either side showed', async () => {
    const popup = fakePopup();
    const control = visibility();
    const result = waitForControlUnlockingIfAsked(popup.page, control, 'pw');
    control.fail(new Error('Target page, context or browser has been closed'));
    await expect(result).rejects.toThrow('Target page, context or browser has been closed');
    expect(popup.steps).toEqual([]);
  });

  it('a loser failing after the race was decided changes nothing', async () => {
    const popup = fakePopup();
    const control = visibility();
    const result = waitForControlUnlockingIfAsked(popup.page, control, 'pw');
    control.show();
    expect(await result).toBe('shown');
    popup.input.fail(new Error('page closed at teardown'));
    await settle();
    expect(popup.steps).toEqual([]);
  });
});
