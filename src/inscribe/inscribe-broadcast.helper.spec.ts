/**
 * Inscribe broadcast helper spec.
 *
 * Pins the fan-out contract:
 *
 *  - POSTs `[commitHex, revealHex]` to every endpoint in parallel.
 *  - `ok: true` iff ANY endpoint reports `package_msg: "success"`.
 *  - `ok: false` when all endpoints reject, including an HTTP 200 whose
 *    `package_msg` says only part of the package went in.
 *  - Network errors and timeouts are absorbed into per-endpoint
 *    `{ ok: false, status: -1 }` rows, never thrown.
 *  - Oversized packages fail closed without hitting the network.
 *
 * Uses a stub `fetchImpl` so the spec runs with no live endpoint.
 */
import { describe, expect, it } from '@jest/globals';

import { STANDARD_TX_WEIGHT_LIMIT } from '../cat21-broadcast/broadcast.helper.js';

import {
  broadcastInscribePackage,
  DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS,
} from './inscribe-broadcast.helper.js';

const COMMIT_HEX = '02000000000101aa'; // shape-only, fan-out doesn't decode
const REVEAL_HEX = '02000000000101bb';

// Bodies ordpool-electrs returns for POST /txs/package, as bitcoind v30.2
// produced them on regtest for a parent P and a child C paying no fee. Both
// come back with HTTP 200; only the first means both are in the mempool.
const PACKAGE_SUCCESS = JSON.stringify({
  package_msg: 'success',
  'tx-results': {
    '47a8833f061a7f1c003061659ab721561da5eda9e341e68f57fd76d6081826fd': { txid: '34958184fcdfa5bffd0eec0d2fa83c738b108e441744fe771e8c64f5ce74188b', vsize: 154 },
    '1d4ec63c1237eca1bd222f8fe4f4befe2e700bc96752f758a084478c42fed8e6': { txid: 'e71ff0ced3838ace36e87e616831ee041de911920dfafc58800abbdffbfdda74', vsize: 111 },
  },
  'replaced-transactions': [],
});
const PACKAGE_PARENT_ONLY = JSON.stringify({
  package_msg: 'transaction failed',
  'tx-results': {
    '47a8833f061a7f1c003061659ab721561da5eda9e341e68f57fd76d6081826fd': { txid: '34958184fcdfa5bffd0eec0d2fa83c738b108e441744fe771e8c64f5ce74188b', vsize: 154, fees: { base: 0.000031 } },
    '1d4ec63c1237eca1bd222f8fe4f4befe2e700bc96752f758a084478c42fed8e6': { txid: 'e71ff0ced3838ace36e87e616831ee041de911920dfafc58800abbdffbfdda74', error: 'min relay fee not met, 0 < 12' },
  },
  'replaced-transactions': [],
});

function stubFetch(
  responses: Record<string, { status: number; body: string } | Error>,
): typeof fetch {
  return (async (url: unknown) => {
    const r = responses[String(url)];
    if (!r) throw new Error(`Unmocked endpoint: ${String(url)}`);
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe('broadcastInscribePackage', () => {
  it('POSTs to all default endpoints in parallel', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify([COMMIT_HEX, REVEAL_HEX]));
      return { ok: true, status: 200, text: async () => PACKAGE_SUCCESS } as Response;
    }) as unknown as typeof fetch;

    const result = await broadcastInscribePackage(
      { commitHex: COMMIT_HEX, revealHex: REVEAL_HEX },
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(result.endpointResults.length).toBe(DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS.length);
    expect(calls.length).toBe(DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS.length);
    for (const ep of DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS) {
      expect(calls.some(c => c.startsWith(ep))).toBe(true);
      expect(calls.some(c => c.endsWith('/txs/package'))).toBe(true);
    }
  });

  it('returns ok=true when any endpoint accepts (even if others reject)', async () => {
    const fetchImpl = stubFetch({
      'https://good.example/txs/package': { status: 200, body: PACKAGE_SUCCESS },
      'https://bad.example/txs/package': { status: 400, body: 'bad-txns-inputs-missingorspent' },
    });

    const result = await broadcastInscribePackage(
      { commitHex: COMMIT_HEX, revealHex: REVEAL_HEX },
      {
        fetchImpl,
        endpoints: ['https://good.example', 'https://bad.example'],
      },
    );

    expect(result.ok).toBe(true);
    expect(result.endpointResults.length).toBe(2);

    const good = result.endpointResults.find(r => r.endpoint.includes('good'))!;
    const bad = result.endpointResults.find(r => r.endpoint.includes('bad'))!;
    expect(good.ok).toBe(true);
    expect(good.status).toBe(200);
    expect(good.body).toBe(PACKAGE_SUCCESS);
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(400);
    expect(bad.body).toBe('bad-txns-inputs-missingorspent');
  });

  it('returns ok=false on HTTP 200 when package_msg says only the parent went in', async () => {
    const fetchImpl = stubFetch({
      'https://api.example/txs/package': { status: 200, body: PACKAGE_PARENT_ONLY },
    });

    const result = await broadcastInscribePackage(
      { commitHex: COMMIT_HEX, revealHex: REVEAL_HEX },
      { fetchImpl, endpoints: ['https://api.example'] },
    );

    expect(result.ok).toBe(false);
    expect(result.endpointResults[0].status).toBe(200);
    expect(result.endpointResults[0].ok).toBe(false);
    expect(result.endpointResults[0].body).toBe(PACKAGE_PARENT_ONLY);
  });

  it('returns ok=false when ALL endpoints reject', async () => {
    const fetchImpl = stubFetch({
      'https://a.example/txs/package': { status: 400, body: 'bad-txns-inputs-missingorspent' },
      'https://b.example/txs/package': { status: 503, body: 'service unavailable' },
    });

    const result = await broadcastInscribePackage(
      { commitHex: COMMIT_HEX, revealHex: REVEAL_HEX },
      { fetchImpl, endpoints: ['https://a.example', 'https://b.example'] },
    );

    expect(result.ok).toBe(false);
    expect(result.endpointResults.every(r => !r.ok)).toBe(true);
  });

  it('absorbs network errors into per-endpoint { ok: false, status: -1 } rows (never throws)', async () => {
    const fetchImpl = stubFetch({
      'https://reachable.example/txs/package': { status: 200, body: PACKAGE_SUCCESS },
      'https://unreachable.example/txs/package': new Error('ECONNREFUSED'),
    });

    const result = await broadcastInscribePackage(
      { commitHex: COMMIT_HEX, revealHex: REVEAL_HEX },
      {
        fetchImpl,
        endpoints: ['https://reachable.example', 'https://unreachable.example'],
      },
    );

    expect(result.ok).toBe(true);
    const errored = result.endpointResults.find(r => r.endpoint.includes('unreachable'))!;
    expect(errored.ok).toBe(false);
    expect(errored.status).toBe(-1);
    expect(errored.body).toBe('ECONNREFUSED');
  });

  it('strips trailing slashes on the endpoint base before appending /txs/package', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => PACKAGE_SUCCESS } as Response;
    }) as unknown as typeof fetch;

    await broadcastInscribePackage(
      { commitHex: COMMIT_HEX, revealHex: REVEAL_HEX },
      { fetchImpl, endpoints: ['https://api.example//'] },
    );

    expect(calls).toEqual(['https://api.example/txs/package']);
  });

  it('fails closed on packageWeight above STANDARD_TX_WEIGHT_LIMIT without hitting the network', async () => {
    let calledNetwork = false;
    const fetchImpl = (async () => {
      calledNetwork = true;
      return { ok: true, status: 200, text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const result = await broadcastInscribePackage(
      {
        commitHex: COMMIT_HEX,
        revealHex: REVEAL_HEX,
        packageWeight: STANDARD_TX_WEIGHT_LIMIT + 1,
      },
      { fetchImpl, endpoints: ['https://wont-be-called.example'] },
    );

    expect(result.ok).toBe(false);
    expect(calledNetwork).toBe(false);
    expect(result.endpointResults.length).toBe(1);
    expect(result.endpointResults[0].endpoint).toBe('(pre-flight)');
    expect(result.endpointResults[0].status).toBe(-1);
    expect(result.endpointResults[0].body).toMatch(/exceeds standard ceiling/);
  });

  it('forwards packageWeight at the exact limit (boundary) to the network', async () => {
    const fetchImpl = stubFetch({
      'https://api.example/txs/package': { status: 200, body: PACKAGE_SUCCESS },
    });

    const result = await broadcastInscribePackage(
      {
        commitHex: COMMIT_HEX,
        revealHex: REVEAL_HEX,
        packageWeight: STANDARD_TX_WEIGHT_LIMIT,
      },
      { fetchImpl, endpoints: ['https://api.example'] },
    );

    expect(result.ok).toBe(true);
  });
});
