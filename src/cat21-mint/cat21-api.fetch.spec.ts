import { fetchCat21Status, fetchLatestCatNumbers } from './cat21-api.fetch';
import { CatNumbersResult, StatusResult } from './cat21-api.types';

// Framework-agnostic twin of Cat21ApiService: pins that it hits the right URL
// (the real builders) and returns the parsed body. global.fetch is mocked.

const BASE = 'https://backend2.cat21.space';
const originalFetch = globalThis.fetch;

function mockFetch(body: unknown, ok = true, status = 200): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((url: string | URL) => {
    calls.push(String(url));
    return Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('cat21-api.fetch — framework-agnostic data client', () => {
  it('fetchCat21Status GETs /api/status and returns the parsed StatusResult', async () => {
    const status: StatusResult = { totalCats: 12345, lastSyncedCatNumber: 12344, proofOfCatWork: 42 };
    const calls = mockFetch(status);
    const result = await fetchCat21Status(BASE);
    expect(calls).toEqual([`${BASE}/api/status`]);
    expect(result).toEqual(status);
  });

  it('fetchLatestCatNumbers GETs /api/cats/numbers/<n>/1 and returns CatNumbersResult', async () => {
    const nums: CatNumbersResult = { catNumbers: [12344, 12343, 12342], total: 12345, currentPage: 1, itemsPerPage: 3 };
    const calls = mockFetch(nums);
    const result = await fetchLatestCatNumbers(BASE, 3);
    expect(calls).toEqual([`${BASE}/api/cats/numbers/3/1`]);
    expect(result).toEqual(nums);
  });

  it('rejects on a non-2xx status, carrying the response body as the message', async () => {
    mockFetch('indexer down', false, 503);
    await expect(fetchCat21Status(BASE)).rejects.toThrow('indexer down');
  });
});
