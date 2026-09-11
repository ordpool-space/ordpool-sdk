import { describe, expect, it } from '@jest/globals';

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
    expect(packInscriptionProperties({ title: '' })).toBeUndefined();
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
    } as unknown as CreateInscribeTransactionsArgs)).toThrow(/either gallery\/title OR raw properties/);
  });
});
