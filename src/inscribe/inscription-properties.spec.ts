import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';

import { packInscriptionProperties } from './inscription-properties';
import { synthesizeEnvelopeFields } from './inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from './inscription.service.helper';

const ID0 = `${'ab'.repeat(32)}i0`;

/**
 * Byte-parity with ord is proven on regtest in
 * e2e/regtest/inscribe-properties-parity.spec.ts. These cover what ord cannot
 * be made to produce: malformed input, and the guard against mixing the typed
 * and raw forms.
 */
describe('packInscriptionProperties', () => {
  it('returns undefined for nothing to encode, so the tag is omitted as ord omits it', () => {
    expect(packInscriptionProperties({})).toBeUndefined();
    expect(packInscriptionProperties({ gallery: [] })).toBeUndefined();
  });

  it('an empty title is still a title: ord writes { 1: { 0: "" } }', () => {
    // ord wallet inscribe --title "" put exactly these bytes into tag 0x11
    // (observed on regtest; the byte-parity spec drives it against ord).
    expect(hex.encode(packInscriptionProperties({ title: '' })!)).toBe('a101a10060');
  });

  it('rejects a malformed inscription id rather than encoding garbage', () => {
    expect(() => packInscriptionProperties({ gallery: ['not-an-id'] })).toThrow(/Invalid inscription id/);
  });

  it('accepts a bare id and an { id } item as the same thing', () => {
    expect(packInscriptionProperties({ gallery: [ID0] }))
      .toEqual(packInscriptionProperties({ gallery: [{ id: ID0 }] }));
  });
});

describe('typed gallery/title vs raw properties', () => {
  it('refuses both at once, since they fill the same tag 0x11', () => {
    expect(() => synthesizeEnvelopeFields({
      gallery: [ID0],
      properties: new Uint8Array([0xa0]),
    } as unknown as CreateInscribeTransactionsArgs)).toThrow(/either gallery\/title\/traits OR raw properties/);
  });
});

describe('traits', () => {
  it('keep their order: a Map and an array of pairs encode the same, and neither is sorted', () => {
    const fromArray = packInscriptionProperties({ traits: [['b', 2], ['a', 1]] })!;
    const fromMap = packInscriptionProperties({ traits: new Map<string, number>([['b', 2], ['a', 1]]) })!;
    expect(hex.encode(fromMap)).toBe(hex.encode(fromArray));
    // { 1: { 1: { "b": 2, "a": 1 } } }: attributes key 1 holds the traits.
    expect(hex.encode(fromArray)).toBe('a101a101a2616202616101');
  });

  it('refuse what ord\'s Trait cannot hold', () => {
    expect(() => packInscriptionProperties({ traits: [['x', 1.5]] })).toThrow('trait x: 1.5 is not an integer');
    expect(() => packInscriptionProperties({ traits: [['x', 1n << 63n]] })).toThrow('trait x: 9223372036854775808 is outside i64');
    expect(() => packInscriptionProperties({ traits: [['x', 1], ['x', 2]] })).toThrow('duplicate trait: x');
  });

  it('empty traits are skipped, as ord skips a default Traits', () => {
    expect(packInscriptionProperties({ traits: [] })).toBeUndefined();
  });
});
