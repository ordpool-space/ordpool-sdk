/**
 * The rune fixture, proven against live ord with `--index-runes`.
 *
 * Until this existed the rune half of the funding-safety scan, and any rune
 * row, could not be exercised at all: neither ord in either compose indexed
 * runes, so `/output.runes` was always null and a seeded rune coin would have
 * been fabricated state in a costume. The compose now passes --index-runes on
 * the stock ord, so a rune coin is a real thing the scan can see and refuse.
 *
 * One etch serves the whole file. `seedRuneCoin` runs a real `ord wallet
 * batch`, which blocks through the etching commitment's six-block maturity,
 * so seeding per test would pay that wait once per assertion for no extra
 * evidence: every test here asks a different question about the SAME coin.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';

import { formatRunePile } from '../../src/cat21-mint/rune-amount';
import {
  SeededRuneCoin,
  getStockOrdOutput,
  rpc,
  seedRuneCoin,
  waitForOrdStockReady,
} from './regtest-helpers';

/** The address the coin is seeded to, standing in for a scanned payment address. */
let address: string;
let coin: SeededRuneCoin;

beforeAll(async () => {
  await waitForOrdStockReady();
  address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'bech32m').trim();
  coin = await seedRuneCoin({ address });
}, 900_000);

describe('seedRuneCoin', () => {
  it('etches a rune and seeds a coin ord really reports as carrying it', async () => {
    const output = await getStockOrdOutput(`${coin.txid}:${coin.vout}`);
    expect(output.runes).not.toBeNull();
    const entry = output.runes?.[coin.runeName];
    expect(entry).toBeDefined();
    expect(entry?.amount).toBe(coin.amount);
    expect(entry?.divisibility).toBe(coin.divisibility);
  }, 120_000);

  it('reports a real etching transaction, not the all-zero txid', () => {
    expect(coin.etchingTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(coin.etchingTxid).not.toBe('0'.repeat(64));
  });

  it('the amount ord emits is the shape the SDK formatter takes', () => {
    // ord's /output emits the amount as a JSON NUMBER; formatRunePile takes it.
    expect(typeof coin.amount).toBe('number');
    const rendered = formatRunePile({
      amount: coin.amount, divisibility: coin.divisibility, symbol: coin.symbol,
    });
    // 100000 base units at divisibility 2, and the separator before the symbol
    // is a NON-BREAKING space (U+00A0), because ord's `Display for Pile` emits
    // one. Written as an escape on purpose: with a literal the two are
    // indistinguishable on screen and in a CI log, which is exactly how a
    // mismatch here reads as "Expected: 1000 @ / Received: 1000 @".
    expect(rendered).toBe(`1000\u00A0${coin.symbol}`);
  });

  it('seeds to the address asked for, where the funding scan reads', () => {
    expect(coin.address).toBe(address);
  });
});
