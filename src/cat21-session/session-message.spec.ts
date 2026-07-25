import { describe, it, expect } from '@jest/globals';

import {
  buildCat21SessionMessage,
  checkSessionValidity,
  CAT21_SESSION_MAX_VALIDITY_MS,
} from './session-message';

describe('buildCat21SessionMessage', () => {
  it('produces the canonical single-line format', () => {
    const msg = buildCat21SessionMessage({
      address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9',
      validUntilIso: '2026-07-26T12:00:00.000Z',
    });
    expect(msg).toBe(
      'Cat21 session: I control bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9, valid until 2026-07-26T12:00:00.000Z',
    );
  });

  it('is deterministic — same inputs, same bytes', () => {
    const a = buildCat21SessionMessage({ address: 'bc1p-x', validUntilIso: '2026-08-01T00:00:00.000Z' });
    const b = buildCat21SessionMessage({ address: 'bc1p-x', validUntilIso: '2026-08-01T00:00:00.000Z' });
    expect(a).toBe(b);
  });

  it('differs when address differs (isolates one signer from another)', () => {
    const a = buildCat21SessionMessage({ address: 'bc1p-x', validUntilIso: '2026-08-01T00:00:00.000Z' });
    const b = buildCat21SessionMessage({ address: 'bc1p-y', validUntilIso: '2026-08-01T00:00:00.000Z' });
    expect(a).not.toBe(b);
  });

  it('differs when validUntilIso differs (a session cannot be extended by reuse)', () => {
    const a = buildCat21SessionMessage({ address: 'bc1p-x', validUntilIso: '2026-08-01T00:00:00.000Z' });
    const b = buildCat21SessionMessage({ address: 'bc1p-x', validUntilIso: '2026-08-02T00:00:00.000Z' });
    expect(a).not.toBe(b);
  });
});

describe('checkSessionValidity', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');

  it('returns null for a future timestamp within cap', () => {
    expect(checkSessionValidity('2026-07-25T13:00:00.000Z', now)).toBeNull();
  });

  it('rejects an expired timestamp', () => {
    expect(checkSessionValidity('2026-07-25T11:00:00.000Z', now)).toBe('session-expired');
  });

  it('rejects a timestamp exactly at now (strict future)', () => {
    expect(checkSessionValidity('2026-07-25T12:00:00.000Z', now)).toBe('session-expired');
  });

  it('rejects a malformed ISO timestamp', () => {
    expect(checkSessionValidity('not-a-date', now)).toBe('malformed-timestamp');
    expect(checkSessionValidity('', now)).toBe('malformed-timestamp');
  });

  it('rejects a session token further out than the max validity cap', () => {
    const tooFar = new Date(now + CAT21_SESSION_MAX_VALIDITY_MS + 1).toISOString();
    expect(checkSessionValidity(tooFar, now)).toBe('session-too-far-in-future');
  });

  it('accepts a session exactly at the max cap', () => {
    const atCap = new Date(now + CAT21_SESSION_MAX_VALIDITY_MS).toISOString();
    expect(checkSessionValidity(atCap, now)).toBeNull();
  });
});
