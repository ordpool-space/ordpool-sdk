/**
 * @test-kind unit
 * Real:   selectCard
 * Faked:  the clock (jest fake timers), the card (click/getAttribute) (shape: @playwright/test Locator)
 * Proves: clicks stop at the reported selection and an unreadable marker is reported as unobservable, never as selected
 */
import { selectCard } from './select-card';

// The marker is read a fixed probe after each click; fake timers run those
// probes without spending real time.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

/** Run every pending probe timer, then hand back the result. */
async function settled<T>(result: Promise<T>): Promise<T> {
  await jest.runAllTimersAsync();
  return result;
}

const card = (attrs: Record<string, string | null>, selectsOnClick = 0) => {
  let clicks = 0;
  return {
    get clicks() { return clicks; },
    click: async () => { clicks++; if (clicks >= selectsOnClick) attrs['aria-checked'] = 'true'; },
    getAttribute: async (n: string) => (n in attrs ? attrs[n] : null),
  };
};

describe('selectCard', () => {
  it('stops at one click when the card reports selected', async () => {
    const c = card({ 'aria-checked': 'false' }, 1);
    const r = await settled(selectCard(c));
    expect(r).toEqual({ clicks: 1, observable: true, selected: true });
  });

  it('re-clicks a swallowed selection until the card reports selected', async () => {
    const c = card({ 'aria-checked': 'false' }, 2);
    const r = await settled(selectCard(c));
    expect(r).toEqual({ clicks: 2, observable: true, selected: true });
    expect(c.clicks).toBe(2);
  });

  it('still runs the retry when the control carries no readable marker', async () => {
    // Unreadable is a statement about the READ-BACK, not about the clicking.
    // A control whose selection is expressed outside every standard marker
    // still needs the retry, so the budget is spent and `selected` stays
    // undefined rather than being claimed.
    const c = card({}, 99);
    const r = await settled(selectCard(c));
    expect(r).toEqual({ clicks: 3, observable: false, selected: undefined });
    expect(c.clicks).toBe(3);
  });

  it('reads a class-based marker when no aria attribute exists', async () => {
    const c = { click: async () => undefined, getAttribute: async (n: string) => (n === 'class' ? 'card selected' : null) };
    expect(await settled(selectCard(c))).toEqual({ clicks: 1, observable: true, selected: true });
  });
});

it('at the cap it reports what the last read said, not an assumption', async () => {
  const c = { click: async () => undefined, getAttribute: async (n: string) => (n === 'aria-checked' ? 'false' : null) };
  expect(await settled(selectCard(c, { maxClicks: 3 }))).toEqual({ clicks: 3, observable: true, selected: false });
});

describe('selectCard — an unreadable marker still gets the full retry', () => {
  it('an EMPTY class means unobservable, and the clicking still runs to the cap', async () => {
    // UniSat's address-type cards carry `class=""` and express selection
    // through an inline background colour. The retry is what makes the
    // selection take: stopping after one click leaves the DEFAULT card
    // selected, and the wallet lands on the wrong address type, which is the
    // bug this helper was written for.
    let clicks = 0;
    const card = {
      click: async () => { clicks++; },
      getAttribute: async (n: string) => (n === 'class' ? '' : null),
    };
    const result = await settled(selectCard(card));
    expect(clicks).toBe(3);
    expect(result).toEqual({ clicks: 3, observable: false, selected: undefined });
  });

  it('a control with NO attributes at all behaves the same way', async () => {
    let clicks = 0;
    const card = {
      click: async () => { clicks++; },
      getAttribute: async () => null,
    };
    const result = await settled(selectCard(card));
    expect(clicks).toBe(3);
    expect(result.observable).toBe(false);
    expect(result.selected).toBeUndefined();
  });

  it('a readable marker still short-circuits on the click that takes', async () => {
    let clicks = 0;
    const card = {
      click: async () => { clicks++; },
      getAttribute: async (n: string) =>
        n === 'aria-selected' ? (clicks >= 2 ? 'true' : 'false') : null,
    };
    const result = await settled(selectCard(card));
    expect(result).toEqual({ clicks: 2, observable: true, selected: true });
  });
});
