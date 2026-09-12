/**
 * The duplicate here was captured live from regtest electrs on 2026-09-12,
 * moments after the funding transaction confirmed: the same outpoint listed
 * twice, once confirmed and once not, for an address that had received
 * 500 000 sats once.
 */

import { describe, expect, it } from '@jest/globals';

import { dedupeUtxosByOutpoint } from './dedupe-utxos';

const TXID = 'a8e8467c132d2198513552b56c4768f989c4af739a9d83b5df7cc60c6c2e708d';
const CONFIRMED = { txid: TXID, vout: 0, value: 500_000, status: { confirmed: true } };
const PENDING = { txid: TXID, vout: 0, value: 500_000, status: { confirmed: false } };

describe('dedupeUtxosByOutpoint', () => {
  it('counts an outpoint electrs listed twice only once', () => {
    const deduped = dedupeUtxosByOutpoint([CONFIRMED, PENDING]);
    expect(deduped).toHaveLength(1);
    expect(deduped.reduce((sum, u) => sum + u.value, 0)).toBe(500_000);
  });

  it('does the same whichever order the copies arrive in', () => {
    expect(dedupeUtxosByOutpoint([PENDING, CONFIRMED])).toHaveLength(1);
  });

  it('keeps genuinely different outpoints, including the same txid at another vout', () => {
    const other = { ...CONFIRMED, vout: 1, value: 100_000 };
    const elsewhere = { ...CONFIRMED, txid: 'b'.repeat(64), value: 7 };
    const deduped = dedupeUtxosByOutpoint([CONFIRMED, other, PENDING, elsewhere]);
    expect(deduped.map(u => `${u.txid}:${u.vout}`)).toEqual([`${TXID}:0`, `${TXID}:1`, `${'b'.repeat(64)}:0`]);
    expect(deduped.reduce((sum, u) => sum + u.value, 0)).toBe(600_007);
  });

  it('preserves the order the endpoint returned', () => {
    const a = { txid: 'a'.repeat(64), vout: 0, value: 1 };
    const b = { txid: 'b'.repeat(64), vout: 0, value: 2 };
    expect(dedupeUtxosByOutpoint([b, a, b]).map(u => u.value)).toEqual([2, 1]);
  });

  it('an empty list stays empty', () => {
    expect(dedupeUtxosByOutpoint([])).toEqual([]);
  });
});
