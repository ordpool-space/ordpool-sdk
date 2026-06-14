import { describe, expect, it, jest } from '@jest/globals';

import {
  SLIPSTREAM_DEFAULT_BASE_URL,
  submitToSlipstream,
} from './slipstream.helper';

/**
 * Lightweight Response-shape stub. jsdom in this jest configuration does
 * not ship the WHATWG Response constructor, so we hand-roll the contract
 * surface used by submitToSlipstream: `ok`, `status`, `text()`, `json()`.
 */
function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

describe('submitToSlipstream', () => {

  it('POSTs to the default Slipstream URL with raw_transaction wrapped', async () => {
    const fetchSpy = jest.fn<typeof fetch>().mockResolvedValue(fakeResponse({ txid: 'abc' }));
    await submitToSlipstream('deadbeef', { fetchImpl: fetchSpy });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${SLIPSTREAM_DEFAULT_BASE_URL}/api/v1/transactions`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ raw_transaction: 'deadbeef' });
  });

  it('returns the parsed { txid } body on success', async () => {
    const fetchSpy = jest.fn<typeof fetch>().mockResolvedValue(fakeResponse({ txid: 'abc123' }));
    const result = await submitToSlipstream('deadbeef', { fetchImpl: fetchSpy });
    expect(result).toEqual({ txid: 'abc123' });
  });

  it('respects an overridden baseUrl (self-hosted miner relay)', async () => {
    const fetchSpy = jest.fn<typeof fetch>().mockResolvedValue(fakeResponse({ txid: 'abc' }));
    await submitToSlipstream('deadbeef', {
      fetchImpl: fetchSpy,
      baseUrl: 'https://miner.example.com',
    });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://miner.example.com/api/v1/transactions');
  });

  it('forwards an AbortSignal to fetch so callers can cancel', async () => {
    const fetchSpy = jest.fn<typeof fetch>().mockResolvedValue(fakeResponse({ txid: 'abc' }));
    const controller = new AbortController();
    await submitToSlipstream('deadbeef', {
      fetchImpl: fetchSpy,
      signal: controller.signal,
    });
    expect(fetchSpy.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('throws on non-2xx with the HTTP status + body text in the message', async () => {
    const fetchSpy = jest
      .fn<typeof fetch>()
      .mockResolvedValue(fakeResponse('bad request', { status: 400 }));
    await expect(submitToSlipstream('deadbeef', { fetchImpl: fetchSpy })).rejects.toThrow(
      /HTTP 400.*bad request/
    );
  });

  it('throws when the response body is missing a txid field', async () => {
    const fetchSpy = jest.fn<typeof fetch>().mockResolvedValue(fakeResponse({ accepted: true }));
    await expect(submitToSlipstream('deadbeef', { fetchImpl: fetchSpy })).rejects.toThrow(
      /missing required "txid"/
    );
  });

  it('throws when the txid field is not a non-empty string', async () => {
    const fetchSpy = jest.fn<typeof fetch>().mockResolvedValue(fakeResponse({ txid: '' }));
    await expect(submitToSlipstream('deadbeef', { fetchImpl: fetchSpy })).rejects.toThrow(
      /missing required "txid"/
    );
  });

  it('throws when rawTxHex is empty', async () => {
    await expect(submitToSlipstream('')).rejects.toThrow(/rawTxHex/);
  });
});
