/**
 * Rare-sat discovery against a live ord with `--index-sats`.
 *
 * `findRareSatsInOutputs` reads ord's `/output/<outpoint>` sat ranges and
 * reports the rarest sat each coin holds. The proof that matters is ord's own
 * verdict: the rarity the SDK derives must equal what ord reports on
 * `GET /sat/<sat>` for that exact sat, and the offset must be where ord's own
 * ranges put it. A regtest coinbase's first sat is a block-first sat, which
 * gives a genuinely non-common sat to find without contriving one.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';

import { findRareSatsInOutputs } from '../../src/inscribe/sat-picker';
import { satPaddingRequirement } from '../../src/inscribe/sat-offset';
import {
  ORD_STOCK_URL,
  getStockOrdOutput,
  getStockOrdSat,
  mineBlocks,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
} from './regtest-helpers';

/** A coinbase-funded tx: vout 0 takes the block-first sat, vout 1 the rest. */
let boundaryCoin: { txid: string; vout: number };
let commonCoin: { txid: string; vout: number };

beforeAll(async () => {
  await waitForOrdStockReady();
  mineBlocks(1);

  const unspent = JSON.parse(rpc('-rpcwallet=ordpool-e2e', 'listunspent', '100')) as Array<{
    txid: string; vout: number; amount: number;
  }>;
  const coin = [...unspent].sort((a, b) => b.amount - a.amount)[0];
  if (!coin) throw new Error('no mature coin to split');

  const dest = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress').trim();
  const raw = rpc(
    'createrawtransaction',
    JSON.stringify([{ txid: coin.txid, vout: coin.vout }]),
    JSON.stringify([{ [dest]: 1 }]),
  );
  // changePosition 0 puts the input's FIRST sats (including the coinbase's
  // block-first sat) on vout 0; vout 1 inherits later, mid-block sats.
  const funded = JSON.parse(
    rpc('-rpcwallet=ordpool-e2e', 'fundrawtransaction', raw, JSON.stringify({ changePosition: 0 })),
  ) as { hex: string };
  const signed = JSON.parse(
    rpc('-rpcwallet=ordpool-e2e', 'signrawtransactionwithwallet', funded.hex),
  ) as { hex: string };
  const txid = rpc('sendrawtransaction', signed.hex).trim();
  const height = mineBlocks(1);
  await waitForElectrsSync(height);
  await waitForOrdStockSync(height);

  boundaryCoin = { txid, vout: 0 };
  commonCoin = { txid, vout: 1 };
}, 240_000);

describe('findRareSatsInOutputs → live ord with a sat index', () => {
  it('finds the block-first sat and agrees with ord on its rarity and its place', async () => {
    const rows = await findRareSatsInOutputs([boundaryCoin], { ordBaseUrl: ORD_STOCK_URL });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('scanned');

    const found = rows[0].rareSat;
    expect(found).not.toBeNull();

    // ord's ranges for this very output put the sat exactly where we say.
    const { sat_ranges } = await getStockOrdOutput(`${boundaryCoin.txid}:${boundaryCoin.vout}`);
    expect(found!.sat).toBe(sat_ranges[0][0]);
    expect(found!.offset).toBe(0);

    // ord's own verdict on that sat, not our arithmetic about it.
    const ordSat = await getStockOrdSat(found!.sat);
    expect(found!.rarity).toBe(ordSat.rarity);
    expect(ordSat.rarity).not.toBe('common');
  }, 120_000);

  it('a coin of mid-block sats is scanned and reports none, and ord agrees', async () => {
    const rows = await findRareSatsInOutputs([commonCoin], { ordBaseUrl: ORD_STOCK_URL });
    expect(rows[0].status).toBe('scanned');
    expect(rows[0].rareSat).toBeNull();

    // Every sat ord lists on this coin is common, so there was nothing to find.
    const { sat_ranges } = await getStockOrdOutput(`${commonCoin.txid}:${commonCoin.vout}`);
    const firstRarity = (await getStockOrdSat(sat_ranges[0][0])).rarity;
    expect(firstRarity).toBe('common');
  }, 120_000);

  it('reports the coin\'s address, which is the dust floor the padding rule uses', async () => {
    const rows = await findRareSatsInOutputs([boundaryCoin], { ordBaseUrl: ORD_STOCK_URL });
    const address = rows[0].address;
    expect(typeof address).toBe('string');

    // Offset 0 needs no padding; one sat in would need the rest of the floor.
    const at0 = satPaddingRequirement(rows[0].rareSat!.offset, address!);
    expect(at0).toEqual({ needsPadding: false, shortfallSats: 0, dustLimitSats: at0.dustLimitSats });
    const at1 = satPaddingRequirement(1, address!);
    expect(at1.needsPadding).toBe(true);
    expect(at1.shortfallSats).toBe(at1.dustLimitSats - 1);
  }, 120_000);

  it('an unreachable ord leaves every coin unknown, never "holds nothing"', async () => {
    const rows = await findRareSatsInOutputs([boundaryCoin, commonCoin], {
      ordBaseUrl: 'http://127.0.0.1:1',
      timeoutMs: 2_000,
    });
    expect(rows.map(r => r.status)).toEqual(['unknown', 'unknown']);
    expect(rows.map(r => r.rareSat)).toEqual([null, null]);
  }, 60_000);
});
