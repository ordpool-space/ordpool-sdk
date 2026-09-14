/**
 * The shared inscribed-coin fixture, proven against live ord.
 *
 * It exists for one spec shape: prove the funding-safety guard REFUSES a coin
 * carrying an inscription. Two properties decide whether such a spec proves
 * anything, and this checks both, because getting either wrong produces a
 * spec that passes while asking the guard nothing.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';

import {
  getStockOrdOutput,
  rpc,
  seedInscribedCoin,
  waitForOrdStockReady,
} from './regtest-helpers';

beforeAll(async () => {
  await waitForOrdStockReady();
}, 180_000);

describe('seedInscribedCoin', () => {
  it('seeds a coin stock ord really reports as inscribed, at the address asked for', async () => {
    const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'bech32').trim();
    const coin = await seedInscribedCoin({ address });

    expect(coin.address).toBe(address);

    // ord's own view, asked independently of the fixture's return value.
    const output = await getStockOrdOutput(`${coin.txid}:${coin.vout}`);
    expect(output.inscriptions).toContain(coin.inscriptionId);
    expect(output.address).toBe(address);
  }, 300_000);

  it('is big enough to be a funding candidate, which is what makes the guard answer', async () => {
    const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'bech32').trim();
    const coin = await seedInscribedCoin({ address, postageSats: 2_000_000 });

    // At ord's default 546 postage the scan may never consider the coin, and a
    // guard spec built on it would pass without the guard ever being asked.
    expect(coin.value).toBeGreaterThanOrEqual(2_000_000);
    expect((await getStockOrdOutput(`${coin.txid}:${coin.vout}`)).value).toBe(coin.value);
  }, 300_000);

  it('honours a smaller postage when a caller wants one', async () => {
    const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'bech32').trim();
    const coin = await seedInscribedCoin({ address, postageSats: 30_000 });
    expect(coin.value).toBeGreaterThanOrEqual(30_000);
    expect(coin.value).toBeLessThan(2_000_000);
  }, 300_000);
});
