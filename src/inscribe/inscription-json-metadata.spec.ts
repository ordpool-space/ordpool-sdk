import { describe, expect, it } from '@jest/globals';

import { encodeJsonMetadata } from './inscription-json-metadata';

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/**
 * Byte-parity with `ord wallet inscribe --json-metadata` is proven on regtest
 * across nine fixtures in e2e/regtest/inscribe-metadata-delegate-parity.spec.ts.
 * These pin the same rules at unit level and cover input ord rejects.
 */
describe('encodeJsonMetadata', () => {
  it('keeps object keys in FILE order, never sorting them', () => {
    // {"name":"Cube","age":1} -> a2 | "name" "Cube" | "age" 1
    expect(hex(encodeJsonMetadata('{"name":"Cube","age":1}')))
      .toBe('a2646e616d65644375626563616765' + '01');
  });

  it('keeps an integer-like key where it was written, which JSON.parse would not', () => {
    // JSON.parse('{"b":1,"1":2}') hoists "1" to the front. ord does not.
    expect(hex(encodeJsonMetadata('{"b":1,"1":2}'))).toBe('a2616201613102');
  });

  it('distinguishes 1 from 1.0 and shrinks floats to f16', () => {
    expect(hex(encodeJsonMetadata('1'))).toBe('01');
    expect(hex(encodeJsonMetadata('1.0'))).toBe('f93c00');
    expect(hex(encodeJsonMetadata('1.5'))).toBe('f93e00');
  });

  it('encodes -0 as the float -0.0, as serde_json does', () => {
    expect(hex(encodeJsonMetadata('-0'))).toBe('f98000');
  });

  it('keeps a duplicate key at its first position with its last value', () => {
    // {"a":1,"b":2,"a":3} -> {"a":3,"b":2}
    expect(hex(encodeJsonMetadata('{"a":1,"b":2,"a":3}'))).toBe('a2616103616202');
  });

  it.each([
    ['trailing garbage', '{} x'],
    ['a lone leading surrogate', '"\\ud800"'],
    ['a leading zero', '01'],
    ['an unterminated string', '"abc'],
  ])('rejects %s, as ord does', (_label, text) => {
    expect(() => encodeJsonMetadata(text)).toThrow(/Invalid JSON metadata/);
  });
});
