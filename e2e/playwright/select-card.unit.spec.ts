import { selectCard } from './select-card';

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
    const r = await selectCard(c, { settleMs: 1 });
    expect(r).toEqual({ clicks: 1, observable: true, selected: true });
  });

  it('re-clicks a swallowed selection until the card reports selected', async () => {
    const c = card({ 'aria-checked': 'false' }, 2);
    const r = await selectCard(c, { settleMs: 1 });
    expect(r).toEqual({ clicks: 2, observable: true, selected: true });
    expect(c.clicks).toBe(2);
  });

  it('still runs the retry when the control carries no readable marker', async () => {
    // Unreadable is a statement about the READ-BACK, not about the clicking.
    // A control whose selection is expressed outside every standard marker
    // still needs the retry, so the budget is spent and `selected` stays
    // undefined rather than being claimed.
    const c = card({}, 99);
    const r = await selectCard(c, { settleMs: 1 });
    expect(r).toEqual({ clicks: 3, observable: false, selected: undefined });
    expect(c.clicks).toBe(3);
  });

  it('reads a class-based marker when no aria attribute exists', async () => {
    const c = { click: async () => undefined, getAttribute: async (n: string) => (n === 'class' ? 'card selected' : null) };
    expect(await selectCard(c, { settleMs: 1 })).toEqual({ clicks: 1, observable: true, selected: true });
  });
});

it('at the cap it reports what the last read said, not an assumption', async () => {
  const c = { click: async () => undefined, getAttribute: async (n: string) => (n === 'aria-checked' ? 'false' : null) };
  expect(await selectCard(c, { settleMs: 1, maxClicks: 3 })).toEqual({ clicks: 3, observable: true, selected: false });
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
    const result = await selectCard(card, { settleMs: 0 });
    expect(clicks).toBe(3);
    expect(result).toEqual({ clicks: 3, observable: false, selected: undefined });
  });

  it('a control with NO attributes at all behaves the same way', async () => {
    let clicks = 0;
    const card = {
      click: async () => { clicks++; },
      getAttribute: async () => null,
    };
    const result = await selectCard(card, { settleMs: 0 });
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
    const result = await selectCard(card, { settleMs: 0 });
    expect(result).toEqual({ clicks: 2, observable: true, selected: true });
  });
});
