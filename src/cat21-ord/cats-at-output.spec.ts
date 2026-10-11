/**
 * @test-kind unit
 * Real:   getCatsAtOutput, cat21OrdFetchReader
 * Faked:  fetch (the reader's IO), answering with cat21-ord bodies captured in cats-at-output.fixtures.ts
 *         (cat21-ord 486f5338, regtest, 2026-10-11) and variations of those bodies named per case
 * Proves: a cat's output reads as its cat number from /inscription, never the id's index; an output without
 *         cats reads as []; a 404 as null; every other shape throws instead of shrinking the list
 *
 * @jest-environment node
 */
import {
  cat21OrdCatInscriptionFixture,
  cat21OrdOutputNotFoundBody,
  cat21OrdOutputWithCatFixture,
  cat21OrdOutputWithoutCatsFixture,
} from './cats-at-output.fixtures';
import { cat21OrdFetchReader, getCatsAtOutput } from './cats-at-output';

const BASE = 'http://cat21-ord.test';
const CAT_TXID = '1b93c1483cce1bca58d4dee25404865ec54f2a394f63e50f90a6155aac469d37';
const CAT_ID = `${CAT_TXID}i0`;
const OTHER_ID = `${'cd'.repeat(32)}i0`;

/** A fetch answering `routes[url]`, a text 404 like cat21-ord's for anything else, recording each call. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; accept: string | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, accept: new Headers(init?.headers).get('accept') });
    const route = routes[url];
    if (!route) return new Response(cat21OrdOutputNotFoundBody, { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

describe('getCatsAtOutput', () => {
  it('reads the captured cat output as cat #2, the /inscription number, asking JSON of the given base', async () => {
    const f = fakeFetch({
      [`${BASE}/output/${CAT_TXID}:0`]: { body: cat21OrdOutputWithCatFixture },
      [`${BASE}/inscription/${CAT_ID}`]: { body: cat21OrdCatInscriptionFixture },
    });
    expect(await getCatsAtOutput(cat21OrdFetchReader(`${BASE}/`, { fetch: f.impl }), CAT_TXID, 0)).toEqual([2]);
    expect(f.calls).toEqual([
      { url: `${BASE}/output/${CAT_TXID}:0`, accept: 'application/json' },
      { url: `${BASE}/inscription/${CAT_ID}`, accept: 'application/json' },
    ]);
  });

  it('reads the captured change output as [] and looks nothing up', async () => {
    const f = fakeFetch({ [`${BASE}/output/${CAT_TXID}:1`]: { body: cat21OrdOutputWithoutCatsFixture } });
    expect(await getCatsAtOutput(cat21OrdFetchReader(BASE, { fetch: f.impl }), CAT_TXID, 1)).toEqual([]);
    expect(f.calls.map((c) => c.url)).toEqual([`${BASE}/output/${CAT_TXID}:1`]);
  });

  it('answers null for the 404 cat21-ord gives an output it never saw', async () => {
    const f = fakeFetch({});
    expect(await getCatsAtOutput(cat21OrdFetchReader(BASE, { fetch: f.impl }), 'ab'.repeat(32), 0)).toBeNull();
  });

  it('asks for the txid in lower case', async () => {
    const f = fakeFetch({
      [`${BASE}/output/${CAT_TXID}:0`]: { body: cat21OrdOutputWithCatFixture },
      [`${BASE}/inscription/${CAT_ID}`]: { body: cat21OrdCatInscriptionFixture },
    });
    expect(await getCatsAtOutput(cat21OrdFetchReader(BASE, { fetch: f.impl }), CAT_TXID.toUpperCase(), 0)).toEqual([2]);
  });

  it('several cats come back ascending and once each; a cursed (negative) number is kept, as /address keeps it', async () => {
    const f = fakeFetch({
      [`${BASE}/output/${CAT_TXID}:0`]: { body: { ...cat21OrdOutputWithCatFixture, cats: [CAT_ID, OTHER_ID, CAT_ID] } },
      [`${BASE}/inscription/${CAT_ID}`]: { body: cat21OrdCatInscriptionFixture },
      [`${BASE}/inscription/${OTHER_ID}`]: { body: { ...cat21OrdCatInscriptionFixture, id: OTHER_ID, number: -1 } },
    });
    expect(await getCatsAtOutput(cat21OrdFetchReader(BASE, { fetch: f.impl }), CAT_TXID, 0)).toEqual([-1, 2]);
  });

  describe('throws instead of shrinking the list', () => {
    const cases: [string, Record<string, { status?: number; body: unknown }>, string][] = [
      ['an /output error other than 404',
        { [`${BASE}/output/${CAT_TXID}:0`]: { status: 500, body: 'boom' } },
        `cat21-ord ${BASE}/output/${CAT_TXID}:0 answered 500`],
      ['an /output body without a cats list',
        { [`${BASE}/output/${CAT_TXID}:0`]: { body: { ...cat21OrdOutputWithCatFixture, cats: undefined } } },
        'has no cats list'],
      ['a cats entry that is a number, not an inscription id',
        { [`${BASE}/output/${CAT_TXID}:0`]: { body: { ...cat21OrdOutputWithCatFixture, cats: [2] } } },
        'lists 2, not an inscription id'],
      ['an inscription id /inscription answers 404 for',
        { [`${BASE}/output/${CAT_TXID}:0`]: { body: cat21OrdOutputWithCatFixture } },
        `lists ${CAT_ID}, which /inscription does not know`],
      ['an inscription whose number is not an integer',
        {
          [`${BASE}/output/${CAT_TXID}:0`]: { body: cat21OrdOutputWithCatFixture },
          [`${BASE}/inscription/${CAT_ID}`]: { body: { ...cat21OrdCatInscriptionFixture, number: '2' } },
        },
        'has number "2", not a cat number'],
    ];
    it.each(cases)('%s', async (_name, routes, message) => {
      const f = fakeFetch(routes);
      await expect(getCatsAtOutput(cat21OrdFetchReader(BASE, { fetch: f.impl }), CAT_TXID, 0)).rejects.toThrow(message);
    });

    it.each([
      ['a txid that is not 64 hex', 'xyz', 0],
      ['a negative output index', CAT_TXID, -1],
      ['a fractional output index', CAT_TXID, 0.5],
    ])('%s, before any request', async (_name, txid, vout) => {
      const f = fakeFetch({});
      await expect(getCatsAtOutput(cat21OrdFetchReader(BASE, { fetch: f.impl }), txid, vout)).rejects.toThrow('getCatsAtOutput:');
      expect(f.calls).toEqual([]);
    });
  });
});
