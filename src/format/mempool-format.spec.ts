import { describe, expect, it } from '@jest/globals';

import {
  formatBitcoinAmount,
  formatSats,
  formatSatsWithUsd,
  groupAddressForVerification,
  addressVerificationChunks,
  shortenId,
} from './mempool-format';

/**
 * Reference implementation, transcribed from mempool's own
 * `bitcoinsatoshis.pipe.ts`. If ours and theirs ever disagree, ordpool.space
 * renders two different formats on one page, so this pins the agreement
 * rather than our opinion of it.
 */
function upstreamBitcoinsatoshis(value: string): string {
  const numValue = parseFloat(value || '0');
  const str = numValue.toFixed(8);
  const [integerPart, decimalPart] = str.split('.');
  const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const formattedDecimal =
    decimalPart.slice(0, 2) + ' ' + decimalPart.slice(2, 5) + ' ' + decimalPart.slice(5);
  return formattedInteger + '.' + formattedDecimal;
}

/** Transcribed from mempool's `shorten-string.pipe.ts`. */
function upstreamShortenString(str: string, length = 12): string | undefined {
  if (!str) return undefined;
  if (str.length <= length) return str;
  const half = length / 2;
  return str.substring(0, half) + '...' + str.substring(str.length - half);
}

describe('formatBitcoinAmount matches mempool byte for byte', () => {
  it.each(['0.00299046', '1234.5', '0', '21000000', '0.00000001'])(
    'agrees with the upstream pipe on %s',
    value => {
      expect(formatBitcoinAmount(value)).toBe(upstreamBitcoinsatoshis(value));
    },
  );

  it('groups the fraction as 2 + 3 + 3, which is upstream\'s shape not ours', () => {
    expect(formatBitcoinAmount('0.00299046')).toBe('0.00 299 046');
  });

  it('groups the integer part in threes', () => {
    expect(formatBitcoinAmount(1234.5)).toBe('1 234.50 000 000');
  });

  it('accepts a number as well as a string', () => {
    expect(formatBitcoinAmount(0.00299046)).toBe(formatBitcoinAmount('0.00299046'));
  });
});

describe('formatSats', () => {
  it('groups in threes with a space', () => {
    expect(formatSats(1234567)).toBe('1 234 567');
    expect(formatSats(546)).toBe('546');
    expect(formatSats(21000)).toBe('21 000');
  });

  it('never emits a separator a reader could take for a decimal point', () => {
    for (const n of [1000, 21000, 1234567, 299046]) {
      expect(formatSats(n)).not.toContain('.');
      expect(formatSats(n)).not.toContain(',');
    }
  });

  it('is the same on every machine, because the locale is not consulted', () => {
    // The defect this exists to prevent: 21000 rendering as "21.000" and
    // being read as twenty-one on a spending prompt.
    expect(formatSats(21000)).toBe('21 000');
    expect(formatSats(21000)).not.toBe('21.000');
  });

  it('handles bigint and negatives', () => {
    expect(formatSats(1234567n)).toBe('1 234 567');
    expect(formatSats(-1234567)).toBe('-1 234 567');
  });
});

describe('formatSatsWithUsd', () => {
  it('appends the current-USD equivalent for a real amount', () => {
    // 3000 sat = 0.00003 BTC; at $65 000/BTC that is exactly $1.95.
    expect(formatSatsWithUsd(3000, 65000)).toBe('3 000 sat (~$1.95)');
  });

  it('drops the USD suffix entirely when there is no live price', () => {
    // null = regtest / failed fetch / cold-start sentinel. The sat count is
    // still honest, so it stands alone rather than showing a fake $0.
    expect(formatSatsWithUsd(3000, null)).toBe('3 000 sat');
  });

  it('shows a real $0.00 for zero sats, not the sub-cent bucket', () => {
    expect(formatSatsWithUsd(0, 65000)).toBe('0 sat ($0.00)');
  });

  it('uses the <$0.01 bucket only for a positive value under a cent', () => {
    // 10 sat = 1e-7 BTC; at $65 000 that is $0.0065, under a cent.
    expect(formatSatsWithUsd(10, 65000)).toBe('10 sat (<$0.01)');
    // 16 sat = $0.0104 — over a cent, so it rounds into the ~$ bucket.
    expect(formatSatsWithUsd(16, 65000)).toBe('16 sat (~$0.01)');
  });

  it('groups the dollar figure in thousands', () => {
    // 1 BTC at $100 000 -> $100,000.00, comma-grouped (en-US), sat still space-grouped.
    expect(formatSatsWithUsd(100_000_000, 100_000)).toBe('100 000 000 sat (~$100,000.00)');
  });

  it('accepts bigint sats identically to number', () => {
    expect(formatSatsWithUsd(3000n, 65000)).toBe(formatSatsWithUsd(3000, 65000));
  });
});

describe('shortenId matches mempool byte for byte', () => {
  const txid = '96ffeb8c2e86a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182930';

  it.each([12, 16, 8])('agrees with the upstream pipe at length %s', length => {
    expect(shortenId(txid, length)).toBe(upstreamShortenString(txid, length));
  });

  it('returns short values untouched', () => {
    expect(shortenId('abc')).toBe('abc');
  });

  it('returns an empty string rather than undefined for empty input', () => {
    // Upstream returns undefined here; a formatter that can emit undefined
    // into a template is a footgun, so this is a deliberate divergence.
    expect(shortenId('')).toBe('');
  });
});

describe('groupAddressForVerification', () => {
  const address = 'bc1putuzj9lyfcm8fef9jpy85nmh33cxuq9u6wyuk536t9kemdk37yjqmkc0pg';

  it('groups in fours so a reader can compare chunk by chunk', () => {
    expect(groupAddressForVerification(address).split(' ')[0]).toBe('bc1p');
    expect(groupAddressForVerification(address).split(' ')[1]).toBe('utuz');
  });

  it('is reversible, because the signer must receive the original bytes', () => {
    expect(groupAddressForVerification(address).split(' ').join('')).toBe(address);
  });

  it('never drops or reorders a character, at any length', () => {
    for (const len of [1, 4, 5, 62, 63]) {
      const value = 'a'.repeat(len - 1) + 'z';
      expect(groupAddressForVerification(value).replace(/ /g, '')).toBe(value);
    }
  });
});

describe('addressVerificationChunks', () => {
  const address = 'bc1putuzj9lyfcm8fef9jpy85nmh33cxuq9u6wyuk536t9kemdk37yjqmkc0pg';

  it('groups in fours, same as the string form', () => {
    expect(addressVerificationChunks(address).slice(0, 2)).toEqual(['bc1p', 'utuz']);
  });

  it('carries NO whitespace, so a dragged selection yields a pasteable address', () => {
    // The whole reason this exists next to groupAddressForVerification: the
    // gaps are drawn in CSS, so what the reader selects is what their wallet
    // accepts. A space here would put the footgun straight back.
    for (const chunk of addressVerificationChunks(address)) {
      expect(chunk).not.toMatch(/\s/);
    }
    expect(addressVerificationChunks(address).join('')).toBe(address);
  });

  it('never drops or reorders a character, at any length', () => {
    for (const len of [1, 4, 5, 62, 63]) {
      const value = 'a'.repeat(len - 1) + 'z';
      expect(addressVerificationChunks(value).join('')).toBe(value);
    }
  });

  it('is empty for an empty address rather than yielding one empty chunk', () => {
    expect(addressVerificationChunks('')).toEqual([]);
  });
});
