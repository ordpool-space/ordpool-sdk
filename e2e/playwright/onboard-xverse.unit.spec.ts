/**
 * @test-kind unit
 * Real:   dismissXversePromo and the visibility probe it uses
 * Faked:  the "Not now" control (click/waitFor, shapes: @playwright/test Locator)
 * Proves: a shown promo is clicked away and must disappear; an absent one is left alone
 */
import { dismissXversePromo } from './onboard-xverse';

function notNow(shown: boolean, goesAway = true) {
  const calls: string[] = [];
  return {
    calls,
    control: {
      waitFor: async (o?: { state?: string; timeout?: number }) => {
        calls.push(`waitFor:${o?.state}`);
        if (o?.state === 'visible' && !shown) throw new Error('probe: not visible');
        if (o?.state === 'hidden' && !goesAway) throw new Error('Not now still visible');
      },
      click: async () => { calls.push('click'); },
    },
  };
}

describe('dismissXversePromo', () => {
  it('clicks a shown promo away and waits for it to go', async () => {
    const { calls, control } = notNow(true);
    await expect(dismissXversePromo(control)).resolves.toBe(true);
    expect(calls).toEqual(['waitFor:visible', 'click', 'waitFor:hidden']);
  });

  it('leaves an absent promo alone', async () => {
    const { calls, control } = notNow(false);
    await expect(dismissXversePromo(control)).resolves.toBe(false);
    expect(calls).toEqual(['waitFor:visible']);
  });

  it('fails when the promo stays after the click', async () => {
    const { control } = notNow(true, false);
    await expect(dismissXversePromo(control)).rejects.toThrow('Not now still visible');
  });
});
