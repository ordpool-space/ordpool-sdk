import { describe, expect, it, jest } from '@jest/globals';

import {
  STANDARD_TX_WEIGHT_LIMIT,
  broadcastCat21,
  decideBroadcastChannel,
} from './broadcast.helper';

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('decideBroadcastChannel', () => {

  it('picks mempool for standard-weight txs', () => {
    expect(decideBroadcastChannel({ hex: 'deadbeef', weight: 600 })).toEqual({
      channel: 'mempool',
      reason: 'standard-weight tx, public mempool is sufficient',
    });
  });

  it('picks slipstream when weight exceeds the standard ceiling', () => {
    const decision = decideBroadcastChannel({
      hex: 'deadbeef',
      weight: STANDARD_TX_WEIGHT_LIMIT + 1,
    });
    expect(decision.channel).toBe('slipstream');
    expect(decision.reason).toContain('exceeds standard ceiling');
  });

  it('picks mempool exactly at the standard ceiling', () => {
    const decision = decideBroadcastChannel({
      hex: 'deadbeef',
      weight: STANDARD_TX_WEIGHT_LIMIT,
    });
    expect(decision.channel).toBe('mempool');
  });

  it('respects forceChannel even when weight would pick the other channel', () => {
    const decision = decideBroadcastChannel(
      { hex: 'deadbeef', weight: STANDARD_TX_WEIGHT_LIMIT + 1 },
      { forceChannel: 'mempool' }
    );
    expect(decision.channel).toBe('mempool');
    expect(decision.reason).toContain('forced');
  });
});

describe('broadcastCat21', () => {

  it('calls the mempool callback for standard-weight txs and returns its txid', async () => {
    const mempool = jest.fn<(hex: string) => Promise<string>>().mockResolvedValue('mempool-txid');
    const fetchSpy = jest.fn<typeof fetch>();

    const result = await broadcastCat21(
      { hex: 'cafebabe', weight: 600 },
      mempool,
      { fetchImpl: fetchSpy }
    );

    expect(mempool).toHaveBeenCalledWith('cafebabe');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ txid: 'mempool-txid', channel: 'mempool' });
  });

  it('routes to slipstream when weight exceeds the ceiling', async () => {
    const mempool = jest.fn<(hex: string) => Promise<string>>();
    const fetchSpy = jest
      .fn<typeof fetch>()
      .mockResolvedValue(fakeResponse({ txid: 'slipstream-txid' }));

    const result = await broadcastCat21(
      { hex: 'cafebabe', weight: STANDARD_TX_WEIGHT_LIMIT + 1 },
      mempool,
      { fetchImpl: fetchSpy }
    );

    expect(mempool).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ txid: 'slipstream-txid', channel: 'slipstream' });
  });

  it('forwards the slipstream bearer token as an Authorization header', async () => {
    const fetchSpy = jest
      .fn<typeof fetch>()
      .mockResolvedValue(fakeResponse({ txid: 'slipstream-txid' }));

    await broadcastCat21(
      { hex: 'cafebabe', weight: STANDARD_TX_WEIGHT_LIMIT + 1 },
      jest.fn<(hex: string) => Promise<string>>(),
      { fetchImpl: fetchSpy, slipstreamBearerToken: 'secret-token' }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
  });

  it('forwards the AbortSignal to slipstream', async () => {
    const fetchSpy = jest
      .fn<typeof fetch>()
      .mockResolvedValue(fakeResponse({ txid: 'slipstream-txid' }));
    const controller = new AbortController();

    await broadcastCat21(
      { hex: 'cafebabe', weight: STANDARD_TX_WEIGHT_LIMIT + 1 },
      jest.fn<(hex: string) => Promise<string>>(),
      { fetchImpl: fetchSpy, signal: controller.signal }
    );

    expect(fetchSpy.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('respects slipstreamBaseUrl override', async () => {
    const fetchSpy = jest
      .fn<typeof fetch>()
      .mockResolvedValue(fakeResponse({ txid: 'slipstream-txid' }));

    await broadcastCat21(
      { hex: 'cafebabe', weight: STANDARD_TX_WEIGHT_LIMIT + 1 },
      jest.fn<(hex: string) => Promise<string>>(),
      { fetchImpl: fetchSpy, slipstreamBaseUrl: 'https://miner.example.com' }
    );

    // Slipstream path was migrated from /api/v1/transactions to /api/transactions
    // (which is the real endpoint, verified by curl against the live host
    // on 2026-06-15 — see slipstream.helper.ts JSDoc for proof).
    expect(fetchSpy.mock.calls[0][0]).toBe('https://miner.example.com/api/transactions');
  });

  it('lets the slipstream error bubble up unchanged (no auto-fallback)', async () => {
    const fetchSpy = jest
      .fn<typeof fetch>()
      .mockResolvedValue(fakeResponse('boom', { status: 500 }));
    const mempool = jest.fn<(hex: string) => Promise<string>>();

    await expect(
      broadcastCat21(
        { hex: 'cafebabe', weight: STANDARD_TX_WEIGHT_LIMIT + 1 },
        mempool,
        { fetchImpl: fetchSpy }
      )
    ).rejects.toThrow(/HTTP 500/);

    expect(mempool).not.toHaveBeenCalled();
  });

  it('honours forceChannel: slipstream even for tiny txs', async () => {
    const fetchSpy = jest
      .fn<typeof fetch>()
      .mockResolvedValue(fakeResponse({ txid: 'slipstream-txid' }));
    const mempool = jest.fn<(hex: string) => Promise<string>>();

    const result = await broadcastCat21(
      { hex: 'cafebabe', weight: 200 },
      mempool,
      { fetchImpl: fetchSpy, forceChannel: 'slipstream' }
    );

    expect(mempool).not.toHaveBeenCalled();
    expect(result.channel).toBe('slipstream');
  });

  // Finding #8 — symmetric to the slipstream-error bubble-up test.
  it('lets a mempool-callback rejection bubble up unchanged (no slipstream auto-fallback)', async () => {
    const mempool = jest
      .fn<(hex: string) => Promise<string>>()
      .mockRejectedValue(new Error('mempool rejected'));
    const fetchSpy = jest.fn<typeof fetch>();

    await expect(
      broadcastCat21({ hex: 'cafebabe', weight: 600 }, mempool, { fetchImpl: fetchSpy })
    ).rejects.toThrow(/mempool rejected/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
