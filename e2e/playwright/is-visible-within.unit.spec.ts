import { isVisibleWithin } from './is-visible-within';

describe('isVisibleWithin', () => {
  it('answers true when the element becomes visible in the window', async () => {
    const seen: number[] = [];
    const locator = {
      waitFor: async ({ timeout }: { state: 'visible'; timeout: number }) => {
        seen.push(timeout);
      },
    };
    await expect(isVisibleWithin(locator, 2_000)).resolves.toBe(true);
    // The timeout must reach waitFor, which is the whole point: the call it
    // replaces accepted a timeout and ignored it.
    expect(seen).toEqual([2_000]);
  });

  it('answers false rather than throwing when the element never appears', async () => {
    const locator = {
      waitFor: async () => {
        throw new Error('locator.waitFor: Timeout 2000ms exceeded');
      },
    };
    await expect(isVisibleWithin(locator, 2_000)).resolves.toBe(false);
  });
});
