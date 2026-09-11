import { describe, expect, it } from '@jest/globals';

import { ORD_TAGS } from './inscription-envelope';
import { synthesizeEnvelopeFields } from './inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from './inscription.service.helper';

/**
 * The tag order ord's `append_reveal_script` emits, read from
 * cat21-ord/src/inscriptions/inscription.rs. Order does not change the
 * resolved inscription, but it decides byte-parity with ord, which is the
 * only standard this module is held to.
 */
const ORD_ORDER = [
  ORD_TAGS.content_encoding,
  ORD_TAGS.metaprotocol,
  ORD_TAGS.parent,
  ORD_TAGS.delegate,
  ORD_TAGS.pointer,
  ORD_TAGS.metadata,
  ORD_TAGS.rune,
  ORD_TAGS.properties,
  ORD_TAGS.property_encoding,
];

const ID = `${'ab'.repeat(32)}i0`;

describe('synthesizeEnvelopeFields emits tags in ord\'s order', () => {
  it('puts every tag in ord\'s append_reveal_script order when all are present', () => {
    const fields = synthesizeEnvelopeFields({
      pointer: 1,
      contentEncoding: 'br',
      metaprotocol: 'brc-20',
      parent: ID,
      delegate: ID,
      metadata: new Uint8Array([0xa0]),
      rune: 1n,
      properties: new Uint8Array([0xa0]),
      propertyEncoding: 'br',
    } as unknown as CreateInscribeTransactionsArgs);

    const order = fields.map(f => f.tag).filter((t, i, a) => a.indexOf(t) === i);
    expect(order).toEqual(ORD_ORDER);
  });

  it('places pointer AFTER delegate, the specific slot it used to get wrong', () => {
    // Pointer first matched ord only when nothing it follows was present.
    // Combined with any of the four tags ord emits before it, the bytes
    // diverged, and no test noticed because none combined them.
    const fields = synthesizeEnvelopeFields({
      pointer: 1,
      metaprotocol: 'brc-20',
    } as unknown as CreateInscribeTransactionsArgs);

    const tags = fields.map(f => f.tag);
    expect(tags.indexOf(ORD_TAGS.metaprotocol)).toBeLessThan(tags.indexOf(ORD_TAGS.pointer));
  });
});
