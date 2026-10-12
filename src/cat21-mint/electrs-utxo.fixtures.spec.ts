/**
 * @test-kind unit
 * Real:   electrsAddressUtxosFixture and its rows (through the ordpool-sdk/testing barrel), Cat21Service.getUtxos, dedupeUtxosByOutpoint
 * Faked:  fetch (getUtxos's IO), answering with the electrs body captured in electrs-utxo.fixtures.ts
 *         (ordpool-electrs 439ef85, regtest, 2026-10-12) and, in one case, that body with its confirmed row listed twice
 * Proves: the fixture is the captured body, each call hands out fresh rows, overrides land on the captured row,
 *         and the SDK's electrs reader returns the captured rows as they are and one row per outpoint
 *
 * @jest-environment node
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { firstValueFrom } from 'rxjs';

import { Network } from '../network.js';
import {
  electrsAddressUtxosFixture,
  electrsAddressUtxosFixtureAddress,
  electrsConfirmedUtxoFixture,
  electrsUnconfirmedUtxoFixture,
} from '../testing.js';
import { Cat21Service } from './cat21.service.js';

/** The body ordpool-electrs 439ef85 answered, byte for byte. */
const CAPTURED_BODY =
  '[{"txid":"481f417f40ab5c08503c14bf5b67e8a769e13097608c0b6076c44ca96f14330b","vout":1,"status":{"confirmed":true,' +
  '"block_height":102,"block_hash":"6c50b3888a5e8ff34428b719db189140dfda1f43a5f2e1cf1198b7215b5131a7","block_time":1791803461},' +
  '"value":100000},{"txid":"be5aa699225b6695b392ec7fc7b55ee73512de73efd549d8dfe4f02192348f47","vout":1,"status":{"confirmed":false},' +
  '"value":50000}]';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** A fetch answering every request with `body` as JSON, recording the URLs. */
function fetchAnswering(body: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return urls;
}

describe('electrsAddressUtxosFixture', () => {
  it('is the captured body: confirmed row first, then the unconfirmed one, fields in electrs order', () => {
    expect(JSON.stringify(electrsAddressUtxosFixture())).toBe(CAPTURED_BODY);
    expect(electrsAddressUtxosFixtureAddress).toBe('bcrt1qw5pw5evmamu6dm5qze7a8yg07wmamvzpq3huc3');
  });

  it('hands out fresh rows on every call', () => {
    const first = electrsAddressUtxosFixture();
    first[0].value = 1;
    first[1].status.confirmed = true;
    expect(JSON.stringify(electrsAddressUtxosFixture())).toBe(CAPTURED_BODY);
  });

  it('puts overrides on top of the captured row and keeps the rest', () => {
    expect(electrsConfirmedUtxoFixture({ txid: 'ab'.repeat(32), value: 30_000 })).toEqual({
      txid: 'ab'.repeat(32),
      vout: 1,
      status: {
        confirmed: true,
        block_height: 102,
        block_hash: '6c50b3888a5e8ff34428b719db189140dfda1f43a5f2e1cf1198b7215b5131a7',
        block_time: 1791803461,
      },
      value: 30_000,
    });
    expect(electrsUnconfirmedUtxoFixture({ vout: 3 })).toEqual({
      txid: 'be5aa699225b6695b392ec7fc7b55ee73512de73efd549d8dfe4f02192348f47',
      vout: 3,
      status: { confirmed: false },
      value: 50000,
    });
  });
});

describe('Cat21Service.getUtxos on the captured electrs answer', () => {
  it('returns both captured rows as electrs listed them, read from the address it was asked for', async () => {
    const urls = fetchAnswering(electrsAddressUtxosFixture());
    const service = new Cat21Service({ mempoolApiUrl: 'http://electrs.test', cat21ApiUrl: '', ordApiUrl: '', cat21OrdApiUrl: '' }, Network.Regtest);

    const utxos = await firstValueFrom(service.getUtxos(electrsAddressUtxosFixtureAddress));

    expect(urls).toEqual([`http://electrs.test/api/address/${electrsAddressUtxosFixtureAddress}/utxo`]);
    expect(JSON.stringify(utxos)).toBe(CAPTURED_BODY);
  });

  it('keeps one row per outpoint when electrs lists the confirmed coin twice', async () => {
    const [confirmed, unconfirmed] = electrsAddressUtxosFixture();
    fetchAnswering([confirmed, electrsConfirmedUtxoFixture({ status: { confirmed: false } }), unconfirmed]);
    const service = new Cat21Service({ mempoolApiUrl: 'http://electrs.test', cat21ApiUrl: '', ordApiUrl: '', cat21OrdApiUrl: '' }, Network.Regtest);

    const utxos = await firstValueFrom(service.getUtxos(electrsAddressUtxosFixtureAddress));

    expect(utxos.map((u) => `${u.txid}:${u.vout} ${u.value}`)).toEqual([
      '481f417f40ab5c08503c14bf5b67e8a769e13097608c0b6076c44ca96f14330b:1 100000',
      'be5aa699225b6695b392ec7fc7b55ee73512de73efd549d8dfe4f02192348f47:1 50000',
    ]);
  });
});
