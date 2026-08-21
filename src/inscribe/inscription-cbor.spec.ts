/**
 * Spec for the deterministic CBOR encoder.
 *
 * Two guarantees are pinned:
 *
 *   1. **Round-trip correctness** — every value the encoder produces
 *      decodes back to the same value through ordpool-parser's
 *      `CBOR.decode` (the same decoder that reads inscription metadata
 *      on chain). Encoder and decoder are inverses.
 *
 *   2. **Determinism / canonical form** — the same logical value always
 *      encodes to the same bytes: integers use the shortest head, map
 *      keys are sorted by their encoded bytes. Pinned with exact byte
 *      arrays so a regression in the head-encoding or key-sort surfaces
 *      immediately.
 */

import { describe, expect, it } from '@jest/globals';
import { CBOR } from 'ordpool-parser';

import { encodeCborDeterministic } from './inscription-cbor';

const decode = (bytes: Uint8Array): unknown => CBOR.decode(bytes);

describe('encodeCborDeterministic — round-trip through ordpool-parser CBOR.decode', () => {

  it('unsigned integers round-trip', () => {
    for (const n of [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296]) {
      expect(decode(encodeCborDeterministic(n))).toBe(n);
    }
  });

  it('negative integers round-trip', () => {
    for (const n of [-1, -24, -25, -256, -257, -65536]) {
      expect(decode(encodeCborDeterministic(n))).toBe(n);
    }
  });

  it('bigint integers round-trip (decoded as JS number within safe range)', () => {
    // The decoder returns JS numbers; compare against Number() so the
    // round-trip assertion holds for values inside 2^53.
    for (const n of [0n, 1n, 1000n, 4294967296n]) {
      expect(decode(encodeCborDeterministic(n))).toBe(Number(n));
    }
  });

  it('strings round-trip (including empty + unicode)', () => {
    for (const s of ['', 'a', 'test', 'grüße 😺', 'x'.repeat(300)]) {
      expect(decode(encodeCborDeterministic(s))).toBe(s);
    }
  });

  it('byte strings round-trip as Uint8Array', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(decode(encodeCborDeterministic(bytes))).toEqual(bytes);
  });

  it('booleans and null round-trip', () => {
    expect(decode(encodeCborDeterministic(true))).toBe(true);
    expect(decode(encodeCborDeterministic(false))).toBe(false);
    expect(decode(encodeCborDeterministic(null))).toBe(null);
  });

  it('arrays round-trip (including nested)', () => {
    const value = [1, 'two', true, [3, 4], null];
    expect(decode(encodeCborDeterministic(value))).toEqual(value);
  });

  it('objects round-trip (string keys)', () => {
    const value = { name: 'test', count: 3, active: true };
    expect(decode(encodeCborDeterministic(value))).toEqual(value);
  });

  it('a realistic nested metadata object round-trips byte-for-byte content', () => {
    const value = {
      name: 'Ordpool Genesis',
      attributes: { rarity: 'legendary', power: 9000 },
      tags: ['cat', 'ordinal', 'genesis'],
      thumbnail: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
    expect(decode(encodeCborDeterministic(value))).toEqual(value);
  });

  it('Map with integer keys round-trips (ord properties use integer keys)', () => {
    const value = new Map<number, unknown>([[0, 'gallery'], [1, 'attrs'], [2, 'packed']]);
    // Decoder returns a plain object with the integer keys coerced to
    // string property names.
    expect(decode(encodeCborDeterministic(value))).toEqual({ 0: 'gallery', 1: 'attrs', 2: 'packed' });
  });
});

describe('encodeCborDeterministic — canonical byte form (exact pins)', () => {

  it('unsigned integer heads use the shortest encoding', () => {
    expect(encodeCborDeterministic(0)).toEqual(new Uint8Array([0x00]));
    expect(encodeCborDeterministic(23)).toEqual(new Uint8Array([0x17]));
    expect(encodeCborDeterministic(24)).toEqual(new Uint8Array([0x18, 0x18]));
    expect(encodeCborDeterministic(255)).toEqual(new Uint8Array([0x18, 0xff]));
    expect(encodeCborDeterministic(256)).toEqual(new Uint8Array([0x19, 0x01, 0x00]));
    expect(encodeCborDeterministic(65536)).toEqual(new Uint8Array([0x1a, 0x00, 0x01, 0x00, 0x00]));
    expect(encodeCborDeterministic(4294967296)).toEqual(
      new Uint8Array([0x1b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
    );
  });

  it('negative integer heads use the shortest encoding (major type 1, stores -(n+1))', () => {
    expect(encodeCborDeterministic(-1)).toEqual(new Uint8Array([0x20]));
    expect(encodeCborDeterministic(-24)).toEqual(new Uint8Array([0x37]));
    expect(encodeCborDeterministic(-25)).toEqual(new Uint8Array([0x38, 0x18]));
  });

  it('short string head', () => {
    expect(encodeCborDeterministic('')).toEqual(new Uint8Array([0x60]));
    expect(encodeCborDeterministic('a')).toEqual(new Uint8Array([0x61, 0x61]));
  });

  it('byte-string head', () => {
    expect(encodeCborDeterministic(new Uint8Array([0xde, 0xad]))).toEqual(
      new Uint8Array([0x42, 0xde, 0xad]),
    );
  });

  it('array + map heads', () => {
    expect(encodeCborDeterministic([1, 2, 3])).toEqual(new Uint8Array([0x83, 0x01, 0x02, 0x03]));
    expect(encodeCborDeterministic({})).toEqual(new Uint8Array([0xa0]));
    expect(encodeCborDeterministic({ a: 1 })).toEqual(new Uint8Array([0xa1, 0x61, 0x61, 0x01]));
  });

  it('map keys are sorted canonically — key insertion order does NOT change the bytes', () => {
    const forward = encodeCborDeterministic({ a: 1, b: 2 });
    const reversed = encodeCborDeterministic({ b: 2, a: 1 });
    // a = 0x6161, b = 0x6162; "a" sorts before "b".
    const expected = new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x62, 0x02]);
    expect(forward).toEqual(expected);
    expect(reversed).toEqual(expected);
  });

  it('integer map keys sort ascending', () => {
    const m = new Map<number, number>([[2, 20], [1, 10], [0, 0]]);
    expect(encodeCborDeterministic(m)).toEqual(
      new Uint8Array([0xa3, 0x00, 0x00, 0x01, 0x0a, 0x02, 0x14]),
    );
  });

  it('is byte-for-byte deterministic across repeated calls', () => {
    const value = { z: [1, 2], a: 'x', m: { b: true, a: null } };
    expect(encodeCborDeterministic(value)).toEqual(encodeCborDeterministic(value));
  });
});

describe('encodeCborDeterministic — rejects unsupported inputs', () => {

  it('throws on undefined', () => {
    expect(() => encodeCborDeterministic(undefined)).toThrow(/undefined/);
  });

  it('throws on a function', () => {
    expect(() => encodeCborDeterministic(() => 1)).toThrow(/function/);
  });

  it('throws on a bigint above u64', () => {
    expect(() => encodeCborDeterministic(1n << 64n)).toThrow(/u64 range/);
  });

  it('throws on a non-finite number', () => {
    expect(() => encodeCborDeterministic(Infinity)).toThrow(/non-finite/);
    expect(() => encodeCborDeterministic(NaN)).toThrow(/non-finite/);
  });

  it('throws on an unsupported map key type', () => {
    const m = new Map<unknown, unknown>([[{ nested: 'key' }, 1]]);
    expect(() => encodeCborDeterministic(m)).toThrow(/map key/);
  });
});
