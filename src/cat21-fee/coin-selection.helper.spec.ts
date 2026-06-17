import { describe, expect, it } from '@jest/globals';

import {
  listFundingUtxosThatCover,
  pickSmallestFundingUtxoThatCovers,
} from './coin-selection.helper';

const u = (txid: string, value: number) => ({ txid, vout: 0, value });

describe('pickSmallestFundingUtxoThatCovers', () => {

  it('returns null on empty utxo list', () => {
    expect(pickSmallestFundingUtxoThatCovers({ utxos: [], targetSpendSats: 1 })).toBeNull();
  });

  it('returns null when no utxo is large enough', () => {
    const utxos = [u('a', 100), u('b', 500), u('c', 999)];
    expect(pickSmallestFundingUtxoThatCovers({ utxos, targetSpendSats: 1_000 })).toBeNull();
  });

  it('returns the smallest utxo that covers the target', () => {
    const utxos = [u('a', 100), u('b', 5_000), u('c', 50_000), u('d', 1_500)];
    expect(pickSmallestFundingUtxoThatCovers({ utxos, targetSpendSats: 1_500 })?.txid).toBe('d');
  });

  it('returns the exact-match utxo when one matches the target precisely', () => {
    const utxos = [u('a', 1_000), u('b', 999), u('c', 10_000)];
    expect(pickSmallestFundingUtxoThatCovers({ utxos, targetSpendSats: 1_000 })?.txid).toBe('a');
  });

  it('rejects non-positive targetSpendSats', () => {
    expect(() => pickSmallestFundingUtxoThatCovers({ utxos: [u('a', 1)], targetSpendSats: 0 })).toThrow(/positive/);
    expect(() => pickSmallestFundingUtxoThatCovers({ utxos: [u('a', 1)], targetSpendSats: -1 })).toThrow(/positive/);
  });
});

describe('listFundingUtxosThatCover', () => {

  it('returns empty array when no utxo covers', () => {
    const utxos = [u('a', 100), u('b', 200)];
    expect(listFundingUtxosThatCover({ utxos, targetSpendSats: 1_000 })).toEqual([]);
  });

  it('lists every covering utxo smallest-first', () => {
    const utxos = [u('big', 50_000), u('small', 1_500), u('medium', 5_000), u('huge', 500_000)];
    const got = listFundingUtxosThatCover({ utxos, targetSpendSats: 1_500 }).map(x => x.txid);
    expect(got).toEqual(['small', 'medium', 'big', 'huge']);
  });

  it('does not mutate the input array', () => {
    const utxos = [u('a', 1_000), u('b', 5_000)];
    const before = utxos.map(x => x.value);
    listFundingUtxosThatCover({ utxos, targetSpendSats: 1_000 });
    expect(utxos.map(x => x.value)).toEqual(before);
  });
});
