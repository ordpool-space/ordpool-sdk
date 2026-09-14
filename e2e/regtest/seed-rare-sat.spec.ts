/**
 * The shared rare-sat fixture, proven against live ord.
 *
 * A consumer's coin-safety panel needs a coin that REALLY carries a notable
 * sat, so the rare-sat row renders from a scanned coin rather than from state
 * the spec made up. This checks the fixture delivers that: ord itself reports
 * the sat as notable, at offset 0 of the seeded coin, at the address asked for.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';

import {
  getStockOrdOutput,
  getStockOrdSat,
  rpc,
  seedRareSatCoin,
  waitForOrdStockReady,
} from './regtest-helpers';

beforeAll(async () => {
  await waitForOrdStockReady();
}, 120_000);

describe('seedRareSatCoin', () => {
  it('seeds a coin whose first sat ord itself calls notable', async () => {
    const coin = await seedRareSatCoin();

    expect(coin.rarity).not.toBe('common');
    // ord's own verdict, asked again independently of the fixture.
    expect((await getStockOrdSat(coin.sat)).rarity).toBe(coin.rarity);

    // The notable sat is the coin's FIRST sat, which is what makes the row
    // about this coin rather than about something buried inside it.
    const output = await getStockOrdOutput(`${coin.txid}:${coin.vout}`);
    expect(output.sat_ranges[0][0]).toBe(coin.sat);
    expect(output.value).toBe(coin.value);
  }, 180_000);

  it('seeds to the address asked for, so it lands in the wallet under test', async () => {
    const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress').trim();
    const coin = await seedRareSatCoin({ address });

    expect(coin.address).toBe(address);
    expect((await getStockOrdOutput(`${coin.txid}:${coin.vout}`)).address).toBe(address);
    expect(coin.rarity).not.toBe('common');
  }, 180_000);

  it('two seeds are separate coins carrying different sats', async () => {
    const a = await seedRareSatCoin();
    const b = await seedRareSatCoin();
    expect(`${a.txid}:${a.vout}`).not.toBe(`${b.txid}:${b.vout}`);
    expect(a.sat).not.toBe(b.sat);
  }, 240_000);
});
