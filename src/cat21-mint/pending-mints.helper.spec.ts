import { describe, expect, it } from '@jest/globals';

import { MempoolTx } from './cat21.service.types';
import {
  gcFirstSeen,
  matchesCat21Mint,
  selectMatchingPendingMints,
  txToPendingMint,
} from './pending-mints.helper';

const ORDINALS_ADDR = 'bc1ptrrx4duc8afs4ye63xgcyf6d7kg29a4myay4nqxmd04zx8j9jers899d0x';
const PAYMENT_ADDR  = 'bc1qfoo';
const OTHER_ADDR    = 'bc1pother';
const QUERY = new Set([ORDINALS_ADDR, PAYMENT_ADDR]);

// Minimal MempoolTx fixtures. Real electrs responses carry more fields
// (vin, scriptpubkey breakdowns, status); the helper only reads what's
// declared in the MempoolTx interface.
const mintTx = (overrides: Partial<MempoolTx> = {}): MempoolTx => ({
  txid: 'a'.repeat(64),
  locktime: 21,
  weight: 704, // → vsize 176
  fee: 880,    // → fee rate 5 sat/vB
  vout: [
    { scriptpubkey_address: ORDINALS_ADDR, value: 546 },
    { scriptpubkey_address: PAYMENT_ADDR, value: 9000 },
  ],
  ...overrides,
});


describe('matchesCat21Mint', () => {

  it('returns true when locktime is 21 and first output address is in the query set', () => {
    expect(matchesCat21Mint(mintTx(), QUERY)).toBe(true);
  });

  it('returns false when locktime is not 21 (regular tx)', () => {
    expect(matchesCat21Mint(mintTx({ locktime: 0 }), QUERY)).toBe(false);
    expect(matchesCat21Mint(mintTx({ locktime: 22 }), QUERY)).toBe(false);
    expect(matchesCat21Mint(mintTx({ locktime: 21 + 100 }), QUERY)).toBe(false);
  });

  it('returns false when the first output address is not in the query set', () => {
    const tx = mintTx({
      vout: [{ scriptpubkey_address: OTHER_ADDR, value: 546 }, { scriptpubkey_address: PAYMENT_ADDR, value: 9000 }],
    });
    expect(matchesCat21Mint(tx, QUERY)).toBe(false);
  });

  it('returns false when the first output has no address (e.g. OP_RETURN as vout[0], unusual but possible)', () => {
    const tx = mintTx({ vout: [{ value: 0 } as MempoolTx['vout'][number], { scriptpubkey_address: ORDINALS_ADDR, value: 546 }] });
    expect(matchesCat21Mint(tx, QUERY)).toBe(false);
  });

  it('only inspects the first output — a queried address in vout[1] does not count', () => {
    const tx = mintTx({
      vout: [
        { scriptpubkey_address: OTHER_ADDR, value: 546 },
        { scriptpubkey_address: ORDINALS_ADDR, value: 9000 },
      ],
    });
    expect(matchesCat21Mint(tx, QUERY)).toBe(false);
  });
});


describe('txToPendingMint', () => {

  it('projects an electrs mempool tx onto the PendingMint shape with exact derived numbers', () => {
    const tx = mintTx({ txid: 'b'.repeat(64), weight: 704, fee: 880 });
    expect(txToPendingMint(tx, '2026-06-08T12:00:00.000Z')).toEqual({
      txid: 'b'.repeat(64),
      vsize: 176,            // ceil(704 / 4)
      fee: 880,
      feeRate: 5,            // 880 / 176 = 5.0
      recipientAddress: ORDINALS_ADDR,
      seenAt: '2026-06-08T12:00:00.000Z',
    });
  });

  it('rounds feeRate to one decimal place', () => {
    // weight 565 → vsize 142 (ceil). fee 999 → 7.035… → 7
    expect(txToPendingMint(mintTx({ weight: 565, fee: 999 }), '2026-06-08T12:00:00.000Z'))
      .toMatchObject({ vsize: 142, feeRate: 7 });

    // weight 565 → vsize 142. fee 1500 → 10.56… → 10.6
    expect(txToPendingMint(mintTx({ weight: 565, fee: 1500 }), '2026-06-08T12:00:00.000Z'))
      .toMatchObject({ vsize: 142, feeRate: 10.6 });

    // weight 600 → vsize 150. fee 1234 → 8.226… → 8.2
    expect(txToPendingMint(mintTx({ weight: 600, fee: 1234 }), '2026-06-08T12:00:00.000Z'))
      .toMatchObject({ vsize: 150, feeRate: 8.2 });
  });

  it('yields a finite feeRate (0) on a degenerate weight=0 entry instead of NaN/Infinity', () => {
    // weight 0 → vsize 0; without the guard fee/vsize is Infinity (fee>0) or NaN (fee=0).
    expect(txToPendingMint(mintTx({ weight: 0, fee: 1500 }), '2026-06-08T12:00:00.000Z'))
      .toMatchObject({ vsize: 0, feeRate: 0 });
    expect(txToPendingMint(mintTx({ weight: 0, fee: 0 }), '2026-06-08T12:00:00.000Z'))
      .toMatchObject({ vsize: 0, feeRate: 0 });
  });
});


describe('selectMatchingPendingMints', () => {

  it('returns mints from a single address array with first-seen set to nowIso', () => {
    const firstSeen = new Map<string, string>();
    const tx = mintTx({ txid: 'c'.repeat(64) });
    const result = selectMatchingPendingMints([[tx]], QUERY, firstSeen, '2026-06-08T12:00:00.000Z');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      txid: 'c'.repeat(64),
      vsize: 176,
      fee: 880,
      feeRate: 5,
      recipientAddress: ORDINALS_ADDR,
      seenAt: '2026-06-08T12:00:00.000Z',
    });
    expect(firstSeen.get('c'.repeat(64))).toBe('2026-06-08T12:00:00.000Z');
  });

  it('dedupes a tx that appears in multiple per-address arrays (one mint touching both ordinals + payment addresses)', () => {
    const firstSeen = new Map<string, string>();
    const tx = mintTx({ txid: 'd'.repeat(64) });
    // Same tx returned from both addresses' mempool endpoints.
    const result = selectMatchingPendingMints([[tx], [tx]], QUERY, firstSeen, '2026-06-08T12:00:00.000Z');

    expect(result).toHaveLength(1);
    expect(result[0].txid).toBe('d'.repeat(64));
  });

  it('preserves seenAt across subsequent calls so the timestamp reflects first sight, not most recent poll', () => {
    const firstSeen = new Map<string, string>();
    const tx = mintTx({ txid: 'e'.repeat(64) });

    const first = selectMatchingPendingMints([[tx]], QUERY, firstSeen, '2026-06-08T12:00:00.000Z');
    expect(first[0].seenAt).toBe('2026-06-08T12:00:00.000Z');

    // 30 seconds later, same tx still in mempool, second poll cycle.
    const second = selectMatchingPendingMints([[tx]], QUERY, firstSeen, '2026-06-08T12:00:30.000Z');
    expect(second[0].seenAt).toBe('2026-06-08T12:00:00.000Z');
  });

  it('drops non-cat21 txs and txs not addressed to the query set', () => {
    const firstSeen = new Map<string, string>();
    const realMint   = mintTx({ txid: 'f'.repeat(64) });
    const regularTx  = mintTx({ txid: '0'.repeat(64), locktime: 0 });
    const otherMint  = mintTx({
      txid: '1'.repeat(64),
      vout: [{ scriptpubkey_address: OTHER_ADDR, value: 546 }, { scriptpubkey_address: PAYMENT_ADDR, value: 9000 }],
    });

    const result = selectMatchingPendingMints([[realMint, regularTx, otherMint]], QUERY, firstSeen, '2026-06-08T12:00:00.000Z');

    expect(result).toHaveLength(1);
    expect(result[0].txid).toBe('f'.repeat(64));
  });
});


describe('gcFirstSeen', () => {

  it('drops entries for txids no longer in the current mempool snapshot', () => {
    const firstSeen = new Map<string, string>([
      ['confirmed-and-mined', '2026-06-08T12:00:00.000Z'],
      ['still-in-mempool',    '2026-06-08T12:00:00.000Z'],
    ]);
    const current = new Set(['still-in-mempool', 'a-newly-seen-one']);

    gcFirstSeen(firstSeen, current);

    expect(firstSeen.has('confirmed-and-mined')).toBe(false);
    expect(firstSeen.get('still-in-mempool')).toBe('2026-06-08T12:00:00.000Z');
  });

  it('is a no-op when the current set still contains every tracked txid', () => {
    const firstSeen = new Map<string, string>([
      ['tx-a', '2026-06-08T12:00:00.000Z'],
      ['tx-b', '2026-06-08T12:00:00.000Z'],
    ]);
    const current = new Set(['tx-a', 'tx-b', 'tx-c']);

    gcFirstSeen(firstSeen, current);

    expect(firstSeen.get('tx-a')).toBe('2026-06-08T12:00:00.000Z');
    expect(firstSeen.get('tx-b')).toBe('2026-06-08T12:00:00.000Z');
  });
});
