/**
 * @jest-environment node
 *
 * The two responses used here were captured live from ord.ordpool.space on
 * 2026-09-13: DOG•GO•TO•THE•MOON, a normally etched rune, and UNCOMMON•GOODS,
 * which the runes protocol reserves rather than etches and which ord therefore
 * reports with an all-zero etching txid. Node env because the mocks build
 * `Response`, which jsdom does not provide.
 */

import { describe, expect, it } from '@jest/globals';

import { lookupRuneEtching, resolveRuneEtchingTxid } from './rune-etching';

const ORD = 'https://ord.example';
const DOG = 'DOG•GO•TO•THE•MOON';
const DOG_ETCHING = 'e79134080a83fe3e0e06ed6990c5a9b63b362313341745707a2bff7d788a1375';
const UNCOMMON = 'UNCOMMON•GOODS';

function ord(byName: Record<string, unknown | number>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    void init;
    const name = decodeURIComponent(url.slice(url.lastIndexOf('/rune/') + '/rune/'.length));
    const body = byName[name];
    if (typeof body === 'number') return new Response('nope', { status: body });
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const dogBody = { entry: { block: 840000, divisibility: 5, etching: DOG_ETCHING, spaced_rune: DOG }, id: '840000:3' };
const uncommonBody = { entry: { block: 1, divisibility: 0, etching: '0'.repeat(64), spaced_rune: UNCOMMON }, id: '1:0' };

/** The common option shape; each test supplies its own ord. */
const opts = (fetchFn: typeof fetch) => ({ ordBaseUrl: ORD, fetchFn });

describe('resolveRuneEtchingTxid', () => {
  it('resolves an etched rune to the transaction that etched it', async () => {
    const txid = await resolveRuneEtchingTxid(DOG, { ordBaseUrl: ORD, fetchFn: ord({ [DOG]: dogBody }) });
    expect(txid).toBe(DOG_ETCHING);
  });

  it('URL-encodes the bullet separators ord spells names with', async () => {
    const seen: string[] = [];
    await resolveRuneEtchingTxid(DOG, { ordBaseUrl: ORD, fetchFn: ord({ [DOG]: dogBody }, seen) });
    expect(seen[0]).toBe(`${ORD}/rune/DOG%E2%80%A2GO%E2%80%A2TO%E2%80%A2THE%E2%80%A2MOON`);
  });

  it('asks for JSON, which ord.ordpool.space refuses to answer without', async () => {
    let accept: string | null = null;
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      accept = new Headers(init?.headers).get('Accept');
      return new Response(JSON.stringify(dogBody), { status: 200 });
    }) as typeof fetch;
    await resolveRuneEtchingTxid(DOG, { ordBaseUrl: ORD, fetchFn });
    expect(accept).toBe('application/json');
  });

  it('a rune with no etching transaction resolves to null, not the all-zero txid', async () => {
    const txid = await resolveRuneEtchingTxid(UNCOMMON, { ordBaseUrl: ORD, fetchFn: ord({ [UNCOMMON]: uncommonBody }) });
    expect(txid).toBeNull();
  });

  it('a name ord does not know resolves to null', async () => {
    expect(await resolveRuneEtchingTxid('NO•SUCH•RUNE', { ordBaseUrl: ORD, fetchFn: ord({}) })).toBeNull();
  });

  it('caches nothing itself: each call asks, so the consumer owns the caching', async () => {
    const seen: string[] = [];
    const fetchFn = ord({ [DOG]: dogBody }, seen);
    expect(await resolveRuneEtchingTxid(DOG, { ordBaseUrl: ORD, fetchFn })).toBe(DOG_ETCHING);
    expect(await resolveRuneEtchingTxid(DOG, { ordBaseUrl: ORD, fetchFn })).toBe(DOG_ETCHING);
    expect(seen).toHaveLength(2);
  });

  it('a lookup that failed can succeed on the next call', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await resolveRuneEtchingTxid(DOG, { ordBaseUrl: ORD, fetchFn: down })).toBeNull();
    expect(await resolveRuneEtchingTxid(DOG, { ordBaseUrl: ORD, fetchFn: ord({ [DOG]: dogBody }) })).toBe(DOG_ETCHING);
  });

  it('a server error resolves to null rather than throwing', async () => {
    expect(await resolveRuneEtchingTxid(DOG, { ordBaseUrl: ORD, fetchFn: ord({ [DOG]: 500 }) })).toBeNull();
  });

  it('a trailing slash on the base URL does not double up', async () => {
    const seen: string[] = [];
    await resolveRuneEtchingTxid(DOG, { ordBaseUrl: `${ORD}/`, fetchFn: ord({ [DOG]: dogBody }, seen) });
    expect(seen[0].startsWith(`${ORD}/rune/`)).toBe(true);
  });
});

describe('lookupRuneEtching: the cases kept apart', () => {
  it('an etched rune reports the transaction', async () => {
    expect(await lookupRuneEtching(DOG, opts(ord({ [DOG]: dogBody }))))
      .toEqual({ kind: 'etched', txid: DOG_ETCHING });
  });

  it('a reserved rune reports not-etched, which is permanent and cacheable', async () => {
    expect(await lookupRuneEtching(UNCOMMON, opts(ord({ [UNCOMMON]: uncommonBody }))))
      .toEqual({ kind: 'not-etched' });
  });

  it('a name ord has no entry for reports unknown, which may change later', async () => {
    expect(await lookupRuneEtching('NO•SUCH•RUNE', opts(ord({}))))
      .toEqual({ kind: 'unknown' });
  });

  it('a failed lookup reports unavailable, which must not be remembered', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await lookupRuneEtching(DOG, opts(down))).toEqual({ kind: 'unavailable' });
    expect(await lookupRuneEtching(DOG, opts(ord({ [DOG]: 500 })))).toEqual({ kind: 'unavailable' });
  });

  it('tells the permanent cases apart from the transient one, which null could not', async () => {
    const reserved = await lookupRuneEtching(UNCOMMON, opts(ord({ [UNCOMMON]: uncommonBody })));
    const outage = await lookupRuneEtching(UNCOMMON, opts((async () => { throw new Error('x'); }) as typeof fetch));

    // Both collapse to null through the narrow function; that is the problem
    // this one exists to solve.
    expect(await resolveRuneEtchingTxid(UNCOMMON, opts(ord({ [UNCOMMON]: uncommonBody })))).toBeNull();
    expect(reserved).not.toEqual(outage);
    expect(reserved.kind).toBe('not-etched');
    expect(outage.kind).toBe('unavailable');
  });

  it('a malformed body is unavailable rather than a wrong answer', async () => {
    expect(await lookupRuneEtching(DOG, opts(ord({ [DOG]: { entry: {} } })))).toEqual({ kind: 'unavailable' });
    expect(await lookupRuneEtching(DOG, opts(ord({ [DOG]: {} })))).toEqual({ kind: 'unavailable' });
  });

  it('the narrow function still answers exactly as before', async () => {
    expect(await resolveRuneEtchingTxid(DOG, opts(ord({ [DOG]: dogBody })))).toBe(DOG_ETCHING);
    expect(await resolveRuneEtchingTxid(UNCOMMON, opts(ord({ [UNCOMMON]: uncommonBody })))).toBeNull();
    expect(await resolveRuneEtchingTxid('NO•SUCH•RUNE', opts(ord({})))).toBeNull();
  });
});
