/**
 * @jest-environment node
 *
 * The ord responses mocked here are the real shape `ord.ordpool.space` and
 * `ord.cat21.space` return for `GET /output/<outpoint>` (captured
 * 2026-09-12 for the CAT-21 genesis cat's output): address, value,
 * sat_ranges as `[start, end)` JSON number pairs, plus the fields we do not
 * read. The live check against an ord with a sat index is in
 * e2e/regtest/inscribe-sat-picker.spec.ts. Node env because the mocked
 * responses are built with `Response`, which jsdom does not provide.
 */

import { describe, expect, it } from '@jest/globals';

import { getMinimumUtxoSize } from '../cat21-script/address-format';
import { findRareSatsInOutputs } from './sat-picker';
import { satPaddingRequirement } from './sat-offset';

const GENESIS_TXID = '98316dcb21daaa221865208fe0323616ee6dd84e6020b78bc6908e914ac03892';
const GENESIS_ADDR = 'bc1p85ra9kv6a48yvk4mq4hx08wxk6t32tdjw9ylahergexkymsc3uwsdrx6sh';

/** The captured response, verbatim apart from the ranges a case overrides. */
function ordOutput(outpoint: string, satRanges: Array<[number, number]>, value = 546) {
  return {
    address: GENESIS_ADDR,
    confirmations: 142427,
    indexed: true,
    inscriptions: [],
    outpoint,
    runes: {},
    sat_ranges: satRanges,
    script_pubkey: '51203d07d2d99aed4e465abb056e679dc6b697152db27149fedf23464d626e188f1d',
    spent: false,
    transaction: outpoint.split(':')[0],
    value,
  };
}

// The genesis cat's real 546 sats: all mid-block, so all common.
const COMMON_RANGE: Array<[number, number]> = [[596964966600565, 596964966601111]];
// The first sat of block 119392, which is uncommon (no block-first sat is common).
const BLOCK_119392_FIRST_SAT = 596960000000000;

function ord(byOutpoint: Record<string, ReturnType<typeof ordOutput> | 'fail'>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const outpoint = url.slice(url.lastIndexOf('/') + 1);
    const body = byOutpoint[outpoint];
    if (body === undefined) return new Response('output not found', { status: 404 });
    if (body === 'fail') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const coin = (txid: string, vout = 0) => ({ txid, vout, value: 546, status: { confirmed: true } });

describe('findRareSatsInOutputs', () => {
  it('a coin of only common sats is scanned and reports no rare sat', async () => {
    const outpoint = `${GENESIS_TXID}:0`;
    const rows = await findRareSatsInOutputs([coin(GENESIS_TXID)], {
      ordBaseUrl: 'https://ord.example',
      fetchFn: ord({ [outpoint]: ordOutput(outpoint, COMMON_RANGE) }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('scanned');
    expect(rows[0].rareSat).toBeNull();
    expect(rows[0].address).toBe(GENESIS_ADDR);
  });

  it('finds a block-first sat and reports where it sits in the coin', async () => {
    const at0 = `${'a'.repeat(64)}:0`;
    const at1000 = `${'b'.repeat(64)}:0`;
    const rows = await findRareSatsInOutputs([coin('a'.repeat(64)), coin('b'.repeat(64))], {
      ordBaseUrl: 'https://ord.example',
      fetchFn: ord({
        // The uncommon sat is the coin's own first sat.
        [at0]: ordOutput(at0, [[BLOCK_119392_FIRST_SAT, BLOCK_119392_FIRST_SAT + 546]]),
        // The same sat, but 1 000 sats into the coin.
        [at1000]: ordOutput(at1000, [[BLOCK_119392_FIRST_SAT - 1000, BLOCK_119392_FIRST_SAT + 100]], 1100),
      }),
    });
    expect(rows[0].rareSat).toEqual({ sat: BLOCK_119392_FIRST_SAT, offset: 0, rarity: 'uncommon' });
    expect(rows[1].rareSat).toEqual({ sat: BLOCK_119392_FIRST_SAT, offset: 1000, rarity: 'uncommon' });
  });

  it('counts the offset across earlier ranges, not just within one', async () => {
    const outpoint = `${'c'.repeat(64)}:0`;
    const rows = await findRareSatsInOutputs([coin('c'.repeat(64))], {
      ordBaseUrl: 'https://ord.example',
      fetchFn: ord({
        [outpoint]: ordOutput(outpoint, [
          [596964966600565, 596964966600765],            // 200 common sats first
          [BLOCK_119392_FIRST_SAT, BLOCK_119392_FIRST_SAT + 346],
        ]),
      }),
    });
    expect(rows[0].rareSat).toEqual({ sat: BLOCK_119392_FIRST_SAT, offset: 200, rarity: 'uncommon' });
  });

  it('a failed lookup is unknown, so a coin is never wrongly ruled out', async () => {
    const down = `${'d'.repeat(64)}:0`;
    const rows = await findRareSatsInOutputs([coin('d'.repeat(64)), coin('e'.repeat(64))], {
      ordBaseUrl: 'https://ord.example',
      fetchFn: ord({ [down]: 'fail' }),
    });
    expect(rows.map(r => r.status)).toEqual(['unknown', 'unknown']);
    expect(rows.map(r => r.rareSat)).toEqual([null, null]);
  });

  it('returns one row per coin, in the order given, handing each coin back', async () => {
    const coins = ['a', 'b', 'c'].map(c => coin(c.repeat(64)));
    const rows = await findRareSatsInOutputs(coins, {
      ordBaseUrl: 'https://ord.example/',
      fetchFn: ord({}),
    });
    expect(rows.map(r => r.utxo)).toEqual(coins);
    expect(rows[0].utxo).toBe(coins[0]);
  });

  it('asks for JSON, as ord answers HTML otherwise', async () => {
    let accept: string | null = null;
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      accept = new Headers(init?.headers).get('Accept');
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await findRareSatsInOutputs([coin('a'.repeat(64))], { ordBaseUrl: 'https://ord.example', fetchFn });
    expect(accept).toBe('application/json');
  });

  it('keeps at most `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const coins = Array.from({ length: 10 }, (_, i) => coin(String(i).repeat(64).slice(0, 64), i));
    const rows = await findRareSatsInOutputs(coins, { ordBaseUrl: 'https://ord.example', fetchFn, concurrency: 3 });
    expect(peak).toBe(3);
    expect(rows).toHaveLength(10);
  });

  it('an ord without a sat index reports no rare sat rather than failing', async () => {
    const outpoint = `${'f'.repeat(64)}:0`;
    const { sat_ranges, ...withoutRanges } = ordOutput(outpoint, []);
    expect(sat_ranges).toEqual([]);
    const rows = await findRareSatsInOutputs([coin('f'.repeat(64))], {
      ordBaseUrl: 'https://ord.example',
      fetchFn: ord({ [outpoint]: withoutRanges as ReturnType<typeof ordOutput> }),
    });
    expect(rows[0]).toEqual({ utxo: expect.anything(), address: GENESIS_ADDR, rareSat: null, status: 'scanned' });
  });
});

describe('satPaddingRequirement', () => {
  // A taproot address's dust floor; the padding output goes to the sat's own
  // coin address for a sat source, so this is the one that applies there.
  const TAPROOT_DUST = getMinimumUtxoSize(GENESIS_ADDR);
  const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

  it('the coin\'s first sat never needs padding', () => {
    expect(satPaddingRequirement(0, GENESIS_ADDR))
      .toEqual({ needsPadding: false, shortfallSats: 0, dustLimitSats: 330 });
    expect(TAPROOT_DUST).toBe(330);
  });

  it('a sat below the dust floor needs exactly the shortfall', () => {
    expect(satPaddingRequirement(100, GENESIS_ADDR))
      .toEqual({ needsPadding: true, shortfallSats: 230, dustLimitSats: 330 });
    expect(satPaddingRequirement(329, GENESIS_ADDR))
      .toEqual({ needsPadding: true, shortfallSats: 1, dustLimitSats: 330 });
  });

  it('a sat at or above the dust floor pays for its own output', () => {
    expect(satPaddingRequirement(330, GENESIS_ADDR))
      .toEqual({ needsPadding: false, shortfallSats: 0, dustLimitSats: 330 });
    expect(satPaddingRequirement(5_000, GENESIS_ADDR))
      .toEqual({ needsPadding: false, shortfallSats: 0, dustLimitSats: 330 });
  });

  it('the floor is the padding address\'s own, not a fixed number', () => {
    expect(satPaddingRequirement(300, P2WPKH))
      .toEqual({ needsPadding: false, shortfallSats: 0, dustLimitSats: 294 });
    expect(satPaddingRequirement(300, GENESIS_ADDR))
      .toEqual({ needsPadding: true, shortfallSats: 30, dustLimitSats: 330 });
  });

  it('refuses a negative or fractional offset', () => {
    expect(() => satPaddingRequirement(-1, GENESIS_ADDR)).toThrow('non-negative integer');
    expect(() => satPaddingRequirement(1.5, GENESIS_ADDR)).toThrow('non-negative integer');
  });
});
