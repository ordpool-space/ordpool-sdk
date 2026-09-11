/**
 * @jest-environment node
 *
 * The responses mocked here are the ones ord.ordpool.space gives
 * (observed 2026-09-12): 200 with the inscription JSON for an existing id,
 * 404 "inscription <id> not found" (text/plain) for a missing one. The live
 * check against stock ord is in e2e/regtest/inscribe-existence.spec.ts.
 */

import { describe, expect, it } from '@jest/globals';

import { checkInscriptionsExist } from './inscription-existence';

const EXISTING = `${'6f'.repeat(32)}i0`;
const MISSING = `${'00'.repeat(32)}i0`;

function ord(routes: Record<string, number | 'throw'>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const id = url.slice(url.lastIndexOf('/') + 1);
    const status = routes[id];
    if (status === 'throw') throw new TypeError('fetch failed');
    if (status === 200) {
      return new Response(JSON.stringify({ id }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(`inscription ${id} not found`, { status: status ?? 404, headers: { 'Content-Type': 'text/plain' } });
  }) as typeof fetch;
}

describe('checkInscriptionsExist', () => {
  it('200 is exists, 404 is missing', async () => {
    const r = await checkInscriptionsExist([EXISTING, MISSING], {
      ordBaseUrl: 'https://ord.example', fetchFn: ord({ [EXISTING]: 200, [MISSING]: 404 }),
    });
    expect([...r.entries()]).toEqual([[EXISTING, 'exists'], [MISSING, 'missing']]);
  });

  it('a failed lookup is unknown, never missing', async () => {
    const down = `${'aa'.repeat(32)}i1`;
    const broken = `${'bb'.repeat(32)}i2`;
    const r = await checkInscriptionsExist([down, broken], {
      ordBaseUrl: 'https://ord.example', fetchFn: ord({ [down]: 'throw', [broken]: 500 }),
    });
    expect(r.get(down)).toBe('unknown');
    expect(r.get(broken)).toBe('unknown');
  });

  it('a malformed id is invalid and costs no request; duplicates are fetched once', async () => {
    const seen: string[] = [];
    const r = await checkInscriptionsExist(['not-an-id', EXISTING, EXISTING], {
      ordBaseUrl: 'https://ord.example/', fetchFn: ord({ [EXISTING]: 200 }, seen),
    });
    expect(r.get('not-an-id')).toBe('invalid');
    expect(r.get(EXISTING)).toBe('exists');
    expect(seen).toEqual([`https://ord.example/inscription/${EXISTING}`]);
  });

  it('asks for JSON, as ord answers HTML otherwise', async () => {
    let accept: string | null = null;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      accept = new Headers(init?.headers).get('Accept');
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await checkInscriptionsExist([EXISTING], { ordBaseUrl: 'https://ord.example', fetchFn });
    expect(accept).toBe('application/json');
  });

  it('keeps at most `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const ids = Array.from({ length: 10 }, (_, i) => `${'cd'.repeat(32)}i${i}`);
    const r = await checkInscriptionsExist(ids, { ordBaseUrl: 'https://ord.example', fetchFn, concurrency: 3 });
    expect(peak).toBe(3);
    expect(r.size).toBe(10);
  });
});
