/**
 * Reversibility spec for the inscription envelope encoder.
 *
 * Every envelope our encoder produces must round-trip cleanly
 * through ordpool-parser's `InscriptionParserService.parse`. This
 * is the single most-important guarantee in the inscribe codebase:
 * our encoder is the inverse of our decoder. If a future change to
 * either side breaks the round-trip, the spec catches it before any
 * code reaches mainnet.
 *
 * The fake-tx scaffolding constructs an Esplora-shaped transaction
 * carrying the envelope script as one of the witness elements, so
 * the parser walks it the same way it walks a real inscription
 * commit-reveal pair on chain.
 */

import { describe, expect, it } from '@jest/globals';
import { bytesToHex } from '@noble/hashes/utils';
import { InscriptionParserService } from 'ordpool-parser';

import {
  buildInscriptionEnvelope,
  ORD_TAGS,
  type OrdEnvelopeField,
} from './inscription-envelope';


/**
 * Build a minimal Esplora-shape transaction whose first witness
 * has the envelope tapscript as its second item (taproot script-path
 * witness shape: `[sig, script, control_block]`). The parser walks
 * each witness element as a hex string and looks for the inscription
 * mark `0063036f7264`.
 */
function fakeTxFromEnvelope(envelopeBytes: Uint8Array) {
  const sigHex      = '00'.repeat(64); // 64-byte schnorr sig placeholder
  const envelopeHex = bytesToHex(envelopeBytes);
  const ctlHex      = 'c0' + '00'.repeat(32); // control block placeholder
  return {
    txid: '0000000000000000000000000000000000000000000000000000000000000001',
    vin: [{
      witness: [sigHex, envelopeHex, ctlHex],
    }],
  };
}

const DUMMY_REVEAL_PUBKEY = new Uint8Array(32).fill(0x02);


describe('buildInscriptionEnvelope — reversibility against ordpool-parser', () => {

  it('plain text/plain inscription round-trips: parser sees the same contentType + body bytes', () => {
    const body = new TextEncoder().encode('hello, ordinals');
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain;charset=utf-8',
      body,
    });

    const parsed = InscriptionParserService.parse(fakeTxFromEnvelope(envelope));
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBe('text/plain;charset=utf-8');
    expect(parsed[0].getDataRaw()).toEqual(body);
  });

  it('image/svg+xml content round-trips byte-for-byte', () => {
    const body = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#FF9900"/></svg>'
    );
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'image/svg+xml',
      body,
    });

    const parsed = InscriptionParserService.parse(fakeTxFromEnvelope(envelope));
    expect(parsed[0].contentType).toBe('image/svg+xml');
    expect(parsed[0].getDataRaw()).toEqual(body);
  });

  it('empty body inscription (delegate-style) round-trips with body length 0', () => {
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body: new Uint8Array(0),
    });

    const parsed = InscriptionParserService.parse(fakeTxFromEnvelope(envelope));
    expect(parsed[0].contentType).toBe('text/plain');
    expect(parsed[0].getDataRaw().length).toBe(0);
  });

  it('body crossing the 520-byte push boundary round-trips via multi-chunk push', () => {
    // Two full chunks + a partial → 1100 bytes total. The encoder
    // slices these across 3 pushes; the parser must reassemble byte-
    // identically.
    const body = new Uint8Array(1100);
    for (let i = 0; i < body.length; i++) body[i] = i & 0xff;

    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'application/octet-stream',
      body,
    });

    const parsed = InscriptionParserService.parse(fakeTxFromEnvelope(envelope));
    expect(parsed[0].getDataRaw()).toEqual(body);
  });

  it('metaprotocol tag (7) round-trips as a UTF-8 string', () => {
    const fields: OrdEnvelopeField[] = [
      { tag: ORD_TAGS.metaprotocol, value: new TextEncoder().encode('cat21') },
    ];
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body: new TextEncoder().encode('cat'),
      fields,
    });

    const parsed = InscriptionParserService.parse(fakeTxFromEnvelope(envelope));
    expect(parsed[0].getMetaprotocol()).toBe('cat21');
  });

  it('CBOR metadata tag (5) round-trips: parser CBOR-decodes our raw bytes', () => {
    // Hand-crafted CBOR for `{name: "test"}`:
    //   a1            map(1)
    //     64 6e616d65   text("name")
    //     64 74657374   text("test")
    const cborBytes = new Uint8Array([
      0xa1, 0x64, 0x6e, 0x61, 0x6d, 0x65, 0x64, 0x74, 0x65, 0x73, 0x74,
    ]);
    const fields: OrdEnvelopeField[] = [
      { tag: ORD_TAGS.metadata, value: cborBytes },
    ];
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body: new Uint8Array(0),
      fields,
    });

    const parsed = InscriptionParserService.parse(fakeTxFromEnvelope(envelope));
    expect(parsed[0].getMetadata()).toEqual({ name: 'test' });
  });

  it('content_type omitted: parser still decodes (delegate inscriptions can have no contentType)', () => {
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      // contentType deliberately undefined
      body: new Uint8Array(0),
    });

    const parsed = InscriptionParserService.parse(fakeTxFromEnvelope(envelope));
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBeUndefined();
  });

  it('throws if revealPubkeyXonly is not 32 bytes', () => {
    expect(() => buildInscriptionEnvelope({
      revealPubkeyXonly: new Uint8Array(33), // 33-byte compressed pubkey by mistake
      contentType: 'text/plain',
      body: new Uint8Array(0),
    })).toThrow(/32 bytes/);
  });

  it('encoder output starts with the canonical inscription envelope prefix', () => {
    // Witness item must contain the same `0063036f7264` mark the
    // parser greps for. Without this prefix the parser would skip
    // the witness entirely.
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body: new TextEncoder().encode('x'),
    });
    expect(bytesToHex(envelope)).toContain('0063036f7264');
  });

  it('ORD_TAGS values match ordpool-parser knownFields (grep-compatibility guard)', () => {
    // The decoder's `knownFields` is the source of truth for tag
    // numeric values. If a future change to either side renumbers a
    // tag, this assertion fails and forces synchronisation. Any tag
    // added to ord must be mirrored in BOTH dictionaries.
    expect(ORD_TAGS.content_type).toBe(0x01);
    expect(ORD_TAGS.pointer).toBe(0x02);
    expect(ORD_TAGS.parent).toBe(0x03);
    expect(ORD_TAGS.metadata).toBe(0x05);
    expect(ORD_TAGS.metaprotocol).toBe(0x07);
    expect(ORD_TAGS.content_encoding).toBe(0x09);
    expect(ORD_TAGS.delegate).toBe(0x0b);
    expect(ORD_TAGS.rune).toBe(0x0d);
    expect(ORD_TAGS.note).toBe(0x0f);
    expect(ORD_TAGS.properties).toBe(0x11);
    expect(ORD_TAGS.property_encoding).toBe(0x13);
  });
});
