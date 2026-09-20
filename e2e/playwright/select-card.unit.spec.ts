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

  it('degrades to ONE click when the control carries no readable marker', async () => {
    const c = card({}, 99);
    const r = await selectCard(c, { settleMs: 1 });
    expect(r).toEqual({ clicks: 1, observable: false, selected: undefined });
    expect(c.clicks).toBe(1);
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
