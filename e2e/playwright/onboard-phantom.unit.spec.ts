/**
 * @test-kind unit
 * Real:   tickPhantomTermsControls
 * Faked:  the two Phantom controls (click/waitFor, shapes: @playwright/test Locator)
 * Proves: the visible box is clicked and the step fails unless the input reports itself checked
 */
import { tickPhantomTermsControls } from './onboard-phantom';

describe('tickPhantomTermsControls', () => {
  it('clicks the box, then waits for the checked input', async () => {
    const calls: string[] = [];
    await tickPhantomTermsControls({
      box: { click: async () => { calls.push('box.click'); } },
      checked: { waitFor: async (o?: { state?: string }) => { calls.push(`checked.${o?.state}`); } },
    } as never);
    expect(calls).toEqual(['box.click', 'checked.attached']);
  });

  it('fails when the input never reports checked', async () => {
    await expect(tickPhantomTermsControls({
      box: { click: async () => undefined },
      checked: { waitFor: () => Promise.reject(new Error('aria-checked="true" never attached')) },
    } as never)).rejects.toThrow('aria-checked="true" never attached');
  });
});
