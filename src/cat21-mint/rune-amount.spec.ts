/**
 * The vectors in the first block are ord's own, transcribed from
 * `cat21-ord/crates/ordinals/src/pile.rs` (`Pile` display tests). They are the
 * reason this helper exists in one place: they decide the trailing-zero
 * question, and they decide it against the intuition that ord shows full
 * precision. ord does not.
 */

import { describe, expect, it } from '@jest/globals';

import { MAX_RUNE_DIVISIBILITY, formatRuneAmount, formatRunePile } from './rune-amount.js';

const U128_MAX = '340282366920938463463374607431768211455';

describe('formatRuneAmount: ord\'s own Pile vectors', () => {
  it.each([
    ['0', 0, '0'],
    ['25', 0, '25'],
    ['0', 1, '0'],
    ['1', 1, '0.1'],
    ['1', 2, '0.01'],
    ['10', 2, '0.1'],          // a trailing zero is stripped, not kept
    ['1100', 3, '1.1'],        // and so are several
    ['100', 2, '1'],           // a zero fraction drops the point entirely
    ['101', 2, '1.01'],
    [U128_MAX, 18, '340282366920938463463.374607431768211455'],
    [U128_MAX, 38, '3.40282366920938463463374607431768211455'],
  ])('%s base units at divisibility %i renders %s', (amount, divisibility, expected) => {
    expect(formatRuneAmount(amount as string, divisibility as number)).toBe(expected);
  });
});

describe('formatRuneAmount: precision', () => {
  it('never goes through a JS number, so a balance past 2^53 stays exact', () => {
    // One base unit above Number.MAX_SAFE_INTEGER. Through a number this
    // renders as ...992, the neighbouring double.
    expect(formatRuneAmount('9007199254740993', 0)).toBe('9007199254740993');
    expect(Number('9007199254740993').toString()).toBe('9007199254740992'); // the trap
  });

  it('keeps every digit of a u128 balance', () => {
    expect(formatRuneAmount(U128_MAX, 0)).toBe(U128_MAX);
  });

  it('takes a bigint as readily as a string', () => {
    expect(formatRuneAmount(1100n, 3)).toBe('1.1');
    expect(formatRuneAmount(BigInt(U128_MAX), 38)).toBe('3.40282366920938463463374607431768211455');
  });

  it('pads a fraction shorter than the divisibility', () => {
    expect(formatRuneAmount('6', 3)).toBe('0.006');
    expect(formatRuneAmount('60', 3)).toBe('0.06');
    expect(formatRuneAmount('1', 18)).toBe('0.000000000000000001');
  });

  it('never uses exponent notation, whatever the scale', () => {
    expect(formatRuneAmount('1', 38)).toBe(`0.${'0'.repeat(37)}1`);
    expect(formatRuneAmount('1', 38)).not.toContain('e');
  });
});

describe('formatRuneAmount: refusals', () => {
  it('refuses an amount that is not plain decimal base units', () => {
    // BigInt() would accept these and quietly mean something else.
    expect(() => formatRuneAmount('0x10', 0)).toThrow('decimal base units');
    expect(() => formatRuneAmount('', 0)).toThrow('decimal base units');
    expect(() => formatRuneAmount('1.5', 1)).toThrow('decimal base units');
    expect(() => formatRuneAmount('1e3', 0)).toThrow('decimal base units');
  });

  it('refuses a negative amount', () => {
    expect(() => formatRuneAmount('-1', 0)).toThrow('decimal base units');
    expect(() => formatRuneAmount(-1n, 0)).toThrow('cannot be negative');
  });

  it('refuses a divisibility ord would not accept', () => {
    expect(MAX_RUNE_DIVISIBILITY).toBe(38);
    expect(() => formatRuneAmount('1', -1)).toThrow('0..38');
    expect(() => formatRuneAmount('1', 39)).toThrow('0..38');
    expect(() => formatRuneAmount('1', 1.5)).toThrow('0..38');
  });
});

describe('formatRunePile: ord\'s complete rendering', () => {
  // Also ord's own vectors: the symbol write is unconditional in the same
  // Display, so these are the same tests with the tail restored.
  const NBSP = '\u00A0'; // written as an escape on purpose: invisible in source is the hazard

  it.each([
    ['0', 0, '¤', `0${NBSP}¤`],
    ['0', 0, '$', `0${NBSP}$`],
    ['1100', 3, '🐕', `1.1${NBSP}🐕`],
    ['100', 2, '⧉', `1${NBSP}⧉`],
  ])('%s at divisibility %i with %s renders %s', (amount, divisibility, symbol, expected) => {
    expect(formatRunePile({ amount: amount as string, divisibility: divisibility as number, symbol: symbol as string }))
      .toBe(expected);
  });

  it('a rune with no symbol falls back to the currency sign, as ord does', () => {
    expect(formatRunePile({ amount: '25', divisibility: 0 })).toBe(`25${NBSP}¤`);
    expect(formatRunePile({ amount: '25', divisibility: 0, symbol: null })).toBe(`25${NBSP}¤`);
    expect(formatRunePile({ amount: '25', divisibility: 0, symbol: '' })).toBe(`25${NBSP}¤`);
  });

  it('separates with U+00A0 and not an ordinary space, which looks the same in review', () => {
    const rendered = formatRunePile({ amount: '1', divisibility: 0, symbol: '$' });
    expect(rendered).toBe('1\u00A0$');   // non-breaking
    expect(rendered).not.toBe('1\u0020$'); // an ordinary space, which looks identical here
    expect(rendered.charCodeAt(1)).toBe(0x00A0);
  });

  it('carries the amount rules through unchanged', () => {
    expect(formatRunePile({ amount: '340282366920938463463374607431768211455', divisibility: 38, symbol: '¤' }))
      .toBe(`3.40282366920938463463374607431768211455${NBSP}¤`);
    expect(() => formatRunePile({ amount: '0x10', divisibility: 0 })).toThrow('decimal base units');
  });
});

describe('formatRuneAmount: the shapes ord actually emits', () => {
  /**
   * Both captured live from ord.ordpool.space on 2026-09-13 for the same
   * holding, which is the point: ord is not consistent between endpoints.
   *
   *   /output/<outpoint>  "runes":{"ANARCHY":{"amount":12600000,...}}   NUMBER
   *   /address/<addr>     "runes_balances":[["ANARCHY","12600000","⬛"]] STRING
   */
  it('takes the number /output/ emits and the string /address/ emits alike', () => {
    expect(formatRuneAmount(12600000, 0)).toBe('12600000');
    expect(formatRuneAmount('12600000', 0)).toBe('12600000');
    expect(formatRunePile({ amount: 12600000, divisibility: 0, symbol: '⬛' })).toBe('12600000 ⬛');
  });

  it('applies the divisibility rules to a number the same way', () => {
    expect(formatRuneAmount(1100, 3)).toBe('1.1');
    expect(formatRuneAmount(100, 2)).toBe('1');
    expect(formatRuneAmount(6, 3)).toBe('0.006');
  });

  it('refuses a fractional number rather than rounding it into a plausible balance', () => {
    expect(() => formatRuneAmount(1.5, 0)).toThrow('non-negative integer');
    expect(() => formatRuneAmount(-1, 0)).toThrow('non-negative integer');
    expect(() => formatRuneAmount(Number.NaN, 0)).toThrow('non-negative integer');
    expect(() => formatRuneAmount(Number.POSITIVE_INFINITY, 0)).toThrow('non-negative integer');
  });

  it('String(n) is the wrong way to convert a big number, BigInt(n) is the right one', () => {
    // The trap a caller falls into when it coerces before calling.
    expect(String(1e21)).toBe('1e+21');
    expect(() => formatRuneAmount(String(1e21), 0)).toThrow('decimal base units');
    expect(formatRuneAmount(BigInt(1e21), 0)).toBe('1000000000000000000000');
  });
});
