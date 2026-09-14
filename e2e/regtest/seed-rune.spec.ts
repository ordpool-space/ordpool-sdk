/**
 * The rune fixture, proven against live ord with `--index-runes`.
 *
 * Until this existed the rune half of the funding-safety scan, and any rune
 * row, could not be exercised at all: neither ord in either compose indexed
 * runes, so `/output.runes` was always null and a seeded rune coin would have
 * been fabricated state in a costume. The compose now passes --index-runes on
 * the stock ord, so a rune coin is a real thing the scan can see and refuse.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';

import { formatRunePile } from '../../src/cat21-mint/rune-amount';
import {
  getStockOrdOutput,
  rpc,
  seedRuneCoin,
  waitForOrdStockReady,
} from './regtest-helpers';

beforeAll(async () => {
  await waitForOrdStockReady();
}, 180_000);

describe('seedRuneCoin', () => {
  it('etches a rune and seeds a coin ord really reports as carrying it', async () => {
    const coin = await seedRuneCoin();

    const output = await getStockOrdOutput(`${coin.txid}:${coin.vout}`);
    expect(output.runes).not.toBeNull();
    const entry = output.runes?.[coin.runeName];
    expect(entry).toBeDefined();
    expect(entry!.amount).toBe(coin.amount);
    expect(entry!.divisibility).toBe(coin.divisibility);
  }, 600_000);

  it('reports a real etching transaction, not the all-zero txid', async () => {
    const coin = await seedRuneCoin();
    expect(coin.etchingTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(coin.etchingTxid).not.toBe('0'.repeat(64));
  }, 600_000);

  it('the amount ord emits is the shape the SDK formatter takes', async () => {
    const coin = await seedRuneCoin();
    // ord's /output emits the amount as a JSON NUMBER; formatRunePile takes it.
    expect(typeof coin.amount).toBe('number');
    const rendered = formatRunePile({
      amount: coin.amount, divisibility: coin.divisibility, symbol: coin.symbol,
    });
    expect(rendered).toBe(`1000 ${coin.symbol}`); // 100000 base units at divisibility 2
  }, 600_000);

  it('seeds to the address asked for, where the funding scan reads', async () => {
    const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'bech32m').trim();
    const coin = await seedRuneCoin({ address });
    expect(coin.address).toBe(address);
    const output = await getStockOrdOutput(`${coin.txid}:${coin.vout}`);
    expect(output.runes?.[coin.runeName]).toBeDefined();
  }, 600_000);
});
