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

import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { findRareSatsInOutputs, inscribeSatSourceFromRow } from '../../src/inscribe/sat-picker';
import { satPaddingRequirement } from '../../src/inscribe/sat-offset';
import { Network, toScureNetwork } from '../../src/network';
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
/** A taproot coin at a key we hold, carrying a block-first sat. */
let ourTaprootCoin: { txid: string; vout: number; value: number };
const ownPriv = schnorr.utils.randomPrivateKey();
const ownXonly = schnorr.getPublicKey(ownPriv);

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

  // A second split, this time paying the input's FIRST sats to a taproot
  // address we hold the key for, so the rare sat sits on a coin we can build
  // a sat source from.
  const ours = btc.p2tr(ownXonly, undefined, toScureNetwork(Network.Regtest), true);
  const unspent2 = JSON.parse(rpc('-rpcwallet=ordpool-e2e', 'listunspent', '100')) as Array<{
    txid: string; vout: number; amount: number;
  }>;
  const coin2 = [...unspent2].sort((a, b) => b.amount - a.amount)[0];
  const raw2 = rpc(
    'createrawtransaction',
    JSON.stringify([{ txid: coin2.txid, vout: coin2.vout }]),
    JSON.stringify([{ [ours.address!]: 0.5 }]),
  );
  // changePosition 1 keeps OUR output at vout 0, so it inherits the input's
  // first sats, the coinbase's block-first sat among them.
  const funded2 = JSON.parse(
    rpc('-rpcwallet=ordpool-e2e', 'fundrawtransaction', raw2, JSON.stringify({ changePosition: 1 })),
  ) as { hex: string };
  const signed2 = JSON.parse(
    rpc('-rpcwallet=ordpool-e2e', 'signrawtransactionwithwallet', funded2.hex),
  ) as { hex: string };
  const txid2 = rpc('sendrawtransaction', signed2.hex).trim();
  const tip2 = mineBlocks(1);
  await waitForElectrsSync(tip2);
  await waitForOrdStockSync(tip2);
  ourTaprootCoin = { txid: txid2, vout: 0, value: 50_000_000 };
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

  it('the sat source it builds carries the script the chain itself holds for that coin', async () => {
    const rows = await findRareSatsInOutputs([ourTaprootCoin], { ordBaseUrl: ORD_STOCK_URL });
    expect(rows[0].status).toBe('scanned');
    expect(rows[0].rareSat).not.toBeNull();

    const source = inscribeSatSourceFromRow(rows[0], {
      ordinalsPublicKey: ownXonly,
      network: Network.Regtest,
    });
    expect(source).not.toBeNull();

    // ord reports the output's own scriptPubKey. Deriving it from the wallet
    // key must reproduce it exactly; swapping the tweaked output key for the
    // untweaked internal key would not.
    const onChain = await getStockOrdOutput(`${ourTaprootCoin.txid}:${ourTaprootCoin.vout}`);
    expect(hex.encode(source!.scriptPubKey)).toBe(onChain.script_pubkey);
    expect(source!.address).toBe(onChain.address);
    expect(source!.value).toBe(ourTaprootCoin.value);
    // The internal key stays untweaked, and is therefore NOT what the script holds.
    expect(Array.from(source!.tapInternalKey)).toEqual(Array.from(ownXonly));
    expect(hex.encode(source!.scriptPubKey.slice(2))).not.toBe(hex.encode(ownXonly));
    expect(source!.offset).toBe(rows[0].rareSat!.offset);
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
