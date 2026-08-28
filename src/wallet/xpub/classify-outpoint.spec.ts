/**
 * @jest-environment node
 *
 * HTTP-touching spec: mocks `fetch`/`Response` (native in node, quirky under
 * jsdom). Same per-file node directive as the other network specs.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { classifyOutpoint } from './classify-outpoint';

const ORD = 'https://ord.ordpool.space';
const CAT21ORD = 'https://ord.cat21.space';
const OUTPOINT = 'aa'.repeat(32) + ':0';

/** Route a mocked fetch by which ord host + path the URL hits. */
function routeFetch(ordBody: unknown, cat21Body: unknown, opts: { ordStatus?: number; cat21Status?: number } = {}) {
  const spy = jest.fn((url: string) => {
    if (url.startsWith(ORD)) return new Response(JSON.stringify(ordBody), { status: opts.ordStatus ?? 200 });
    if (url.startsWith(CAT21ORD)) return new Response(JSON.stringify(cat21Body), { status: opts.cat21Status ?? 200 });
    return new Response('nope', { status: 404 });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
  return spy;
}

afterEach(() => { jest.restoreAllMocks(); });

describe('classifyOutpoint', () => {
  it('is clean when neither ord reports any content (mid-block range, no assets)', async () => {
    routeFetch(
      { inscriptions: [], runes: null, sat_ranges: [[1_000_000_000, 1_000_000_010]] },
      { cats: [], sat_ranges: [] },
    );

    const c = await classifyOutpoint(OUTPOINT, { ordApiUrl: ORD, cat21OrdApiUrl: CAT21ORD });

    expect(c.clean).toBe(true);
    expect(c.outpoint).toBe(OUTPOINT);
    expect(c.inscriptionIds).toEqual([]);
    expect(c.catIds).toEqual([]);
    expect(c.rareSat).toBeNull();
  });

  it('is NOT clean when the full ord reports an inscription', async () => {
    routeFetch(
      { inscriptions: ['bb'.repeat(32) + 'i0'], runes: null, sat_ranges: [[1_000_000_000, 1_000_000_010]] },
      { cats: [], sat_ranges: [] },
    );

    const c = await classifyOutpoint(OUTPOINT, { ordApiUrl: ORD, cat21OrdApiUrl: CAT21ORD });

    expect(c.clean).toBe(false);
    expect(c.inscriptionIds).toEqual(['bb'.repeat(32) + 'i0']);
  });

  it('is NOT clean when cat21-ord reports a cat, and reads catSat from cat21-ord ranges', async () => {
    routeFetch(
      { inscriptions: [], runes: null, sat_ranges: [[1_000_000_000, 1_000_000_010]] },
      { cats: ['cc'.repeat(32) + 'i0'], sat_ranges: [[596_964_966_600_565, 596_964_966_600_566]] },
    );

    const c = await classifyOutpoint(OUTPOINT, { ordApiUrl: ORD, cat21OrdApiUrl: CAT21ORD });

    expect(c.clean).toBe(false);
    expect(c.catIds).toEqual(['cc'.repeat(32) + 'i0']);
    expect(c.catSat).toBe(596_964_966_600_565);
  });

  it('is NOT clean when the range holds a rare sat (sat 0 = mythic)', async () => {
    routeFetch(
      { inscriptions: [], runes: null, sat_ranges: [[0, 1]] },
      { cats: [], sat_ranges: [] },
    );

    const c = await classifyOutpoint(OUTPOINT, { ordApiUrl: ORD, cat21OrdApiUrl: CAT21ORD });

    expect(c.clean).toBe(false);
    expect(c.rareSat).not.toBeNull();
  });

  it('is NOT clean when a rune is present', async () => {
    routeFetch(
      { inscriptions: [], runes: { 'UNCOMMON•GOODS': { amount: '1' } }, sat_ranges: [[1_000_000_000, 1_000_000_010]] },
      { cats: [], sat_ranges: [] },
    );

    const c = await classifyOutpoint(OUTPOINT, { ordApiUrl: ORD, cat21OrdApiUrl: CAT21ORD });

    expect(c.clean).toBe(false);
    expect(c.runes).not.toBeNull();
  });

  it('requests /output with Accept: application/json from both ords', async () => {
    const spy = routeFetch(
      { inscriptions: [], runes: null, sat_ranges: [] },
      { cats: [], sat_ranges: [] },
    );

    await classifyOutpoint(OUTPOINT, { ordApiUrl: ORD, cat21OrdApiUrl: CAT21ORD });

    const urls = spy.mock.calls.map((c) => (c as [string])[0]);
    expect(urls).toContain(`${ORD}/output/${OUTPOINT}`);
    expect(urls).toContain(`${CAT21ORD}/output/${OUTPOINT}`);
  });

  it('throws when either ord returns a non-2xx', async () => {
    routeFetch({ inscriptions: [] }, { cats: [] }, { ordStatus: 502 });

    await expect(classifyOutpoint(OUTPOINT, { ordApiUrl: ORD, cat21OrdApiUrl: CAT21ORD }))
      .rejects.toThrow(/returned 502/);
  });
});
