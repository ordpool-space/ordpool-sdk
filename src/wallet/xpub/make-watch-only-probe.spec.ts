/**
 * @jest-environment node
 *
 * HTTP-touching spec: mocks `fetch`/`Response` (native in node, quirky under
 * jsdom). Same per-file node directive as the other network specs.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { makeWatchOnlyProbe } from './make-watch-only-probe';

const ESPLORA = 'https://api.ordpool.space';
const ORD = 'https://ord.ordpool.space';
const CAT21ORD = 'https://ord.cat21.space';

const CONFIG = { esploraApiUrl: ESPLORA, ordApiUrl: ORD, cat21OrdApiUrl: CAT21ORD };

const CLEAN_OUTPUT = { inscriptions: [], runes: null, sat_ranges: [[1_000_000_000, 1_000_000_010]] };
const NO_CATS = { cats: [], sat_ranges: [] };

/** Drive the whole probe with a per-URL handler. */
function mockFetch(handler: (url: string) => { body: unknown; status?: number }) {
  const spy = jest.fn((url: string) => {
    const { body, status } = handler(url);
    return new Response(JSON.stringify(body), { status: status ?? 200 });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
  return spy;
}

afterEach(() => { jest.restoreAllMocks(); });

describe('makeWatchOnlyProbe', () => {
  it('reports a single clean UTXO as funded, no cat', async () => {
    mockFetch((url) => {
      if (url.startsWith(ESPLORA)) return { body: [{ txid: 'aa'.repeat(32), vout: 0, value: 12_000 }] };
      if (url.startsWith(CAT21ORD) && url.includes('/address/')) return { body: { cat_numbers: [] } };
      if (url.startsWith(ORD)) return { body: CLEAN_OUTPUT };
      return { body: NO_CATS };
    });

    const probe = makeWatchOnlyProbe(CONFIG);
    const result = await probe('bc1pclean');

    expect(result).toEqual({ funded: true, fundedSats: 12_000, hasCat: false });
  });

  it('excludes a cat UTXO from funds and reports hasCat from the cat index', async () => {
    mockFetch((url) => {
      if (url.startsWith(ESPLORA)) return { body: [{ txid: 'cc'.repeat(32), vout: 0, value: 546 }] };
      if (url.startsWith(CAT21ORD) && url.includes('/address/')) return { body: { cat_numbers: [42] } };
      if (url.startsWith(ORD)) return { body: CLEAN_OUTPUT };
      // cat21-ord /output: the UTXO holds the cat -> not clean
      return { body: { cats: ['cc'.repeat(32) + 'i0'], sat_ranges: [[500_000_000, 500_000_001]] } };
    });

    const probe = makeWatchOnlyProbe(CONFIG);
    const result = await probe('bc1pcat');

    expect(result).toEqual({ funded: false, fundedSats: 0, hasCat: true });
  });

  it('sums only the clean UTXOs when funds and an inscription share the address', async () => {
    mockFetch((url) => {
      if (url.startsWith(ESPLORA)) {
        return { body: [
          { txid: 'aa'.repeat(32), vout: 0, value: 12_000 },  // clean
          { txid: 'bb'.repeat(32), vout: 0, value: 8_000 },    // inscription
        ] };
      }
      if (url.startsWith(CAT21ORD) && url.includes('/address/')) return { body: { cat_numbers: [] } };
      if (url.startsWith(ORD) && url.includes('bb'.repeat(32))) {
        return { body: { inscriptions: ['bb'.repeat(32) + 'i0'], runes: null, sat_ranges: [[1_000_000_000, 1_000_000_010]] } };
      }
      if (url.startsWith(ORD)) return { body: CLEAN_OUTPUT };
      return { body: NO_CATS };
    });

    const probe = makeWatchOnlyProbe(CONFIG);
    const result = await probe('bc1pmixed');

    expect(result).toEqual({ funded: true, fundedSats: 12_000, hasCat: false });
  });

  it('excludes an unclassifiable UTXO (ord error) from funds, conservatively', async () => {
    mockFetch((url) => {
      if (url.startsWith(ESPLORA)) return { body: [{ txid: 'aa'.repeat(32), vout: 0, value: 12_000 }] };
      if (url.startsWith(CAT21ORD) && url.includes('/address/')) return { body: { cat_numbers: [] } };
      if (url.startsWith(ORD)) return { body: 'boom', status: 502 };  // classifyOutpoint throws
      return { body: NO_CATS };
    });

    const probe = makeWatchOnlyProbe(CONFIG);
    const result = await probe('bc1punknown');

    expect(result).toEqual({ funded: false, fundedSats: 0, hasCat: false });
  });

  it('returns unfunded for an address with no UTXOs (esplora 404)', async () => {
    mockFetch((url) => {
      if (url.startsWith(ESPLORA)) return { body: 'not found', status: 404 };
      if (url.startsWith(CAT21ORD) && url.includes('/address/')) return { body: { cat_numbers: [] } };
      return { body: NO_CATS };
    });

    const probe = makeWatchOnlyProbe(CONFIG);
    const result = await probe('bc1pempty');

    expect(result).toEqual({ funded: false, fundedSats: 0, hasCat: false });
  });
});
