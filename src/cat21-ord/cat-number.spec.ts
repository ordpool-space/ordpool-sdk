/**
 * @test-kind unit
 * Real:   lookupCatNumber
 * Faked:  fetch, answering with the captured regtest cat21-ord /inscription body (cats-at-output.fixtures.ts) or
 *         failure shapes named per case
 * Proves: the cat number is read from `number`; every failure (a non-2xx even with a numeric body, cat21-ord's
 *         plain-text 404, a network error, a non-integer number) gives null instead of throwing
 *
 * @jest-environment node
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { lookupCatNumber } from './cat-number.js';
import { cat21OrdCatInscriptionFixture, cat21OrdOutputNotFoundBody } from './cats-at-output.fixtures.js';

const BASE = 'http://cat21-ord.test/';
const ID = cat21OrdCatInscriptionFixture.id;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function answer(make: () => Promise<Response>) {
  const spy = jest.fn((_url: string, _init?: RequestInit) => make());
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('lookupCatNumber', () => {
  it('reads the number from cat21-ord /inscription, asking JSON of the trimmed base', async () => {
    const spy = answer(async () => new Response(JSON.stringify(cat21OrdCatInscriptionFixture), { status: 200 }));

    expect(await lookupCatNumber(BASE, ID)).toBe(2);
    expect(spy.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get('accept')]))
      .toEqual([[`http://cat21-ord.test/inscription/${ID}`, 'application/json']]);
  });

  it.each([
    ['a non-2xx with a numeric body', async () => new Response(JSON.stringify({ number: 7 }), { status: 503 })],
    ['cat21-ord\'s plain-text 404', async () => new Response(cat21OrdOutputNotFoundBody, { status: 404 })],
    ['a network error', async () => { throw new TypeError('fetch failed'); }],
    ['a non-integer number', async () => new Response(JSON.stringify({ ...cat21OrdCatInscriptionFixture, number: 2.5 }), { status: 200 })],
  ] as const)('%s gives null', async (_label, make) => {
    answer(make);

    expect(await lookupCatNumber(BASE, ID)).toBeNull();
  });
});
