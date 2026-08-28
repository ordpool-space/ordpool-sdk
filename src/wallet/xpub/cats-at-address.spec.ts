/**
 * @jest-environment node
 *
 * HTTP-touching spec: mocks `fetch`/`Response`, which behave natively in
 * node but hit jsdom's Response quirks under the browser config. Same
 * per-file node directive the SDK uses for its other network specs.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { addressHoldsCat, catsAtAddress } from './cats-at-address';

/**
 * Real cat21-ord `/address/{address}` response, captured from
 * `https://ord.cat21.space/address/bc1p85ra9kv6a48yvk4mq4hx08wxk6t32tdjw9ylahergexkymsc3uwsdrx6sh`
 * (the genesis-mint address). Trimmed to the fields this helper reads;
 * `cats`/`cat_numbers` are 1:1 in the real body (8 entries each). Note the
 * wire field is `cats`, serde-renamed from the Rust `inscriptions` field.
 */
const REAL_ADDRESS_INFO = {
  outputs: [
    '4130bd5520fff85dd98aeb8a3e03895062afb2cfd5215f878a9df835b261980e:0',
    '76448f79c6c90281ec4d15f3a027c48d3a1f72e9de20f4ca3461932384866513:0',
  ],
  cats: [
    '4130bd5520fff85dd98aeb8a3e03895062afb2cfd5215f878a9df835b261980ei0',
    '76448f79c6c90281ec4d15f3a027c48d3a1f72e9de20f4ca3461932384866513i0',
  ],
  cat_numbers: [27, 10, 9, 8, 7, 6, 5, 1],
  sat_balance: 5022,
  runes_balances: null,
};

const ORD = 'https://ord.cat21.space';

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = jest.fn(impl as never);
  (globalThis as unknown as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
  return spy;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('catsAtAddress', () => {
  it('returns the cat_numbers array from a real cat21-ord response', async () => {
    mockFetch(() => new Response(JSON.stringify(REAL_ADDRESS_INFO), { status: 200 }));

    const cats = await catsAtAddress('bc1pcat', { cat21OrdApiUrl: ORD });

    expect(cats).toEqual([27, 10, 9, 8, 7, 6, 5, 1]);
  });

  it('requests JSON from the /address path (cat21-ord runs --disable-html)', async () => {
    const spy = mockFetch(() => new Response(JSON.stringify(REAL_ADDRESS_INFO), { status: 200 }));

    await catsAtAddress('bc1pcat', { cat21OrdApiUrl: ORD });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ord.cat21.space/address/bc1pcat');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const spy = mockFetch(() => new Response(JSON.stringify(REAL_ADDRESS_INFO), { status: 200 }));

    await catsAtAddress('bc1pcat', { cat21OrdApiUrl: 'https://ord.cat21.space/' });

    expect((spy.mock.calls[0] as [string])[0]).toBe('https://ord.cat21.space/address/bc1pcat');
  });

  it('returns [] for a 404 (address cat21-ord has never seen)', async () => {
    mockFetch(() => new Response('not found', { status: 404 }));

    expect(await catsAtAddress('bc1pnew', { cat21OrdApiUrl: ORD })).toEqual([]);
  });

  it('returns [] when cat_numbers is null (address has outputs but no cats)', async () => {
    mockFetch(() => new Response(JSON.stringify({ ...REAL_ADDRESS_INFO, cat_numbers: null, cats: [] }), { status: 200 }));

    expect(await catsAtAddress('bc1pplain', { cat21OrdApiUrl: ORD })).toEqual([]);
  });

  it('throws on a non-404 error status', async () => {
    mockFetch(() => new Response('boom', { status: 502 }));

    await expect(catsAtAddress('bc1pcat', { cat21OrdApiUrl: ORD }))
      .rejects.toThrow(/returned 502/);
  });

  it('forwards the AbortSignal to fetch', async () => {
    const spy = mockFetch(() => new Response(JSON.stringify(REAL_ADDRESS_INFO), { status: 200 }));
    const controller = new AbortController();

    await catsAtAddress('bc1pcat', { cat21OrdApiUrl: ORD, signal: controller.signal });

    expect((spy.mock.calls[0] as [string, RequestInit])[1].signal).toBe(controller.signal);
  });
});

describe('addressHoldsCat', () => {
  it('is true when the address holds at least one cat', async () => {
    mockFetch(() => new Response(JSON.stringify(REAL_ADDRESS_INFO), { status: 200 }));

    expect(await addressHoldsCat('bc1pcat', { cat21OrdApiUrl: ORD })).toBe(true);
  });

  it('is false for an empty cat set', async () => {
    mockFetch(() => new Response(JSON.stringify({ ...REAL_ADDRESS_INFO, cat_numbers: [], cats: [] }), { status: 200 }));

    expect(await addressHoldsCat('bc1pplain', { cat21OrdApiUrl: ORD })).toBe(false);
  });

  it('is false for a never-seen (404) address', async () => {
    mockFetch(() => new Response('not found', { status: 404 }));

    expect(await addressHoldsCat('bc1pnew', { cat21OrdApiUrl: ORD })).toBe(false);
  });
});
