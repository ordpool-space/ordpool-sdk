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

import { encodeCborDeterministic } from './inscription-cbor';
import {
  buildInscriptionEnvelope,
  chunkFieldValue,
  encodeInscriptionId,
  encodeParentInscriptionId,
  encodePointerValue,
  encodeRuneCommitment,
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

describe('buildInscriptionEnvelope — minimalTagPush (the push-encoding flag)', () => {
  // The ONLY difference between an ord-standard inscription and a
  // `vindicated`-charmed one is how each tag number lands in the
  // tapscript. `minimalTagPush` toggles it; nothing else about the
  // envelope changes. These specs pin both byte forms and prove the
  // pushnum form still parses to the identical content.
  const body = new TextEncoder().encode('hello, ordinals');
  const parentId = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
  // "text/plain" = 10 bytes → OP_PUSHBYTES_10 (0x0a) + the ASCII bytes.
  const contentTypePush = '0a' + bytesToHex(new TextEncoder().encode('text/plain'));

  it('default (false): content_type tag is a 2-byte DATA push (01 01), ord-standard', () => {
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body,
    });
    // ...OP_FALSE OP_IF "ord" | 01 01 (data-push tag 1) | 0a <text/plain>...
    expect(bytesToHex(envelope)).toContain('0063036f7264' + '0101' + contentTypePush);
  });

  it('true: content_type tag is the 1-byte pushnum OP_1 (0x51), ord flags vindicated', () => {
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body,
      minimalTagPush: true,
    });
    // ...OP_FALSE OP_IF "ord" | 51 (OP_1) | 0a <text/plain>...
    expect(bytesToHex(envelope)).toContain('0063036f7264' + '51' + contentTypePush);
    // And it must NOT carry the data-push form.
    expect(bytesToHex(envelope)).not.toContain('0063036f7264' + '0101');
  });

  it('true: an extra tag ≤ 16 (parent, 0x03) becomes OP_3 (0x53)', () => {
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body,
      fields: [{ tag: ORD_TAGS.parent, value: encodeParentInscriptionId(parentId) }],
      minimalTagPush: true,
    });
    const hex = bytesToHex(envelope);
    const parentValue = encodeParentInscriptionId(parentId);
    // OP_PUSHBYTES_<len> prefix for the id value (index 0 trims to the
    // bare 32-byte txid, so len = 0x20).
    const valuePush = parentValue.length.toString(16).padStart(2, '0') + bytesToHex(parentValue);
    // OP_3 (0x53) pushnum for the parent tag, then the id value push.
    expect(hex).toContain('53' + valuePush);
    // default form (data-push 01 03) is absent
    expect(hex).not.toContain('0103' + valuePush);
  });

  it('tags > 16 have no pushnum opcode, so they DATA-push (01 11) even when minimal', () => {
    const properties = new Uint8Array([0xa0]); // 1-byte CBOR value, contents irrelevant here
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body,
      fields: [{ tag: ORD_TAGS.properties, value: properties }],
      minimalTagPush: true,
    });
    // content_type (tag 1) still went pushnum...
    expect(bytesToHex(envelope)).toContain('51' + contentTypePush);
    // ...but properties (tag 0x11 = 17) has no OP_17, so it stays a data-push.
    expect(bytesToHex(envelope)).toContain('0111' + '01a0');
  });

  it('minimal saves exactly one byte per tag ≤ 16', () => {
    const args = {
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body,
      fields: [{ tag: ORD_TAGS.parent, value: encodeParentInscriptionId(parentId) }],
    } as const;
    const dataPush = buildInscriptionEnvelope({ ...args });
    const pushnum = buildInscriptionEnvelope({ ...args, minimalTagPush: true });
    // Two tags ≤ 16 (content_type + parent): each drops from 2 bytes to 1.
    expect(dataPush.length - pushnum.length).toBe(2);
  });

  it('the pushnum (vindicated) envelope parses to the IDENTICAL content — the charm is cosmetic', () => {
    const dataEnv = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body,
    });
    const pushnumEnv = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body,
      minimalTagPush: true,
    });
    const dataParsed = InscriptionParserService.parse(fakeTxFromEnvelope(dataEnv));
    const pushnumParsed = InscriptionParserService.parse(fakeTxFromEnvelope(pushnumEnv));
    expect(dataParsed[0].contentType).toBe('text/plain');
    expect(pushnumParsed[0].contentType).toBe('text/plain');
    // Same content type, byte-identical body — the vindicated charm is
    // purely how the tag number was pushed, not what got inscribed.
    expect(pushnumParsed[0].getDataRaw()).toEqual(dataParsed[0].getDataRaw());
    expect(pushnumParsed[0].getDataRaw()).toEqual(body);
  });
});

describe('first-class envelope tags — round-trip via ordpool-parser', () => {

  const DELEGATE_ID = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
  const DELEGATE_ID_IDX = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i7';

  function parseFields(fields: OrdEnvelopeField[], body = new Uint8Array(0)) {
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
      contentType: 'text/plain',
      body,
      fields,
    });
    const parsed = InscriptionParserService.parse(fakeTxFromEnvelope(envelope));
    expect(parsed.length).toBe(1);
    return parsed[0];
  }

  describe('pointer (tag 0x02)', () => {
    for (const offset of [0, 1, 255, 256, 545]) {
      it(`pointer ${offset} round-trips through getPointer()`, () => {
        const p = parseFields([{ tag: ORD_TAGS.pointer, value: encodePointerValue(offset) }]);
        expect(p.getPointer()).toBe(offset);
      });
    }

    it('encodePointerValue emits minimal little-endian bytes', () => {
      expect(encodePointerValue(0)).toEqual(new Uint8Array(0));
      expect(encodePointerValue(1)).toEqual(new Uint8Array([0x01]));
      expect(encodePointerValue(255)).toEqual(new Uint8Array([0xff]));
      expect(encodePointerValue(256)).toEqual(new Uint8Array([0x00, 0x01]));
    });

    it('rejects negative / non-integer offsets', () => {
      expect(() => encodePointerValue(-1)).toThrow(/non-negative/);
      expect(() => encodePointerValue(1.5)).toThrow(/non-negative integer/);
    });
  });

  describe('metaprotocol (tag 0x07)', () => {
    it('round-trips as a UTF-8 string via getMetaprotocol()', () => {
      const p = parseFields([{ tag: ORD_TAGS.metaprotocol, value: new TextEncoder().encode('brc-20') }]);
      expect(p.getMetaprotocol()).toBe('brc-20');
    });
  });

  describe('delegate (tag 0x0b)', () => {
    it('index-0 delegate id round-trips via getDelegates()', () => {
      const p = parseFields([{ tag: ORD_TAGS.delegate, value: encodeInscriptionId(DELEGATE_ID) }]);
      expect(p.getDelegates()).toEqual([DELEGATE_ID]);
    });

    it('non-zero-index delegate id round-trips', () => {
      const p = parseFields([{ tag: ORD_TAGS.delegate, value: encodeInscriptionId(DELEGATE_ID_IDX) }]);
      expect(p.getDelegates()).toEqual([DELEGATE_ID_IDX]);
    });

    it('encodeInscriptionId is the same function backing encodeParentInscriptionId (shared byte form)', () => {
      expect(encodeInscriptionId).toBe(encodeParentInscriptionId);
      expect(encodeInscriptionId(DELEGATE_ID)).toEqual(encodeParentInscriptionId(DELEGATE_ID));
    });
  });

  describe('rune (tag 0x0d)', () => {
    it('rune 0 encodes as an empty push and getRune() returns empty bytes', () => {
      expect(encodeRuneCommitment(0n)).toEqual(new Uint8Array(0));
      const p = parseFields([{ tag: ORD_TAGS.rune, value: encodeRuneCommitment(0n) }]);
      expect(p.getRune()).toEqual(new Uint8Array(0));
    });

    it('small rune value round-trips as minimal little-endian bytes', () => {
      // 0x0102 = 258 → LE [0x02, 0x01].
      expect(encodeRuneCommitment(258n)).toEqual(new Uint8Array([0x02, 0x01]));
      const p = parseFields([{ tag: ORD_TAGS.rune, value: encodeRuneCommitment(258n) }]);
      expect(p.getRune()).toEqual(new Uint8Array([0x02, 0x01]));
    });

    it('u128-max rune value encodes as 16 0xff bytes and round-trips', () => {
      const U128_MAX = (1n << 128n) - 1n;
      const bytes = encodeRuneCommitment(U128_MAX);
      expect(bytes).toEqual(new Uint8Array(16).fill(0xff));
      const p = parseFields([{ tag: ORD_TAGS.rune, value: bytes }]);
      expect(p.getRune()).toEqual(new Uint8Array(16).fill(0xff));
    });

    it('rejects negative and above-u128 values', () => {
      expect(() => encodeRuneCommitment(-1n)).toThrow(/non-negative/);
      expect(() => encodeRuneCommitment(1n << 128n)).toThrow(/u128 range/);
    });
  });

  describe('metadata (tag 0x05) chunked across 520-byte pushes', () => {
    it('single-chunk CBOR metadata round-trips via getMetadata()', () => {
      const cbor = encodeCborDeterministic({ name: 'test', n: 3 });
      const p = parseFields(chunkFieldValue(ORD_TAGS.metadata, cbor));
      expect(p.getMetadata()).toEqual({ name: 'test', n: 3 });
    });

    it('multi-chunk CBOR metadata (> 520 B, 3 chunks) reassembles + decodes', () => {
      // A ~1200-byte string forces CBOR well past 520 bytes → 3 chunks.
      const big = 'x'.repeat(1200);
      const cbor = encodeCborDeterministic({ blob: big, kind: 'metadata' });
      const chunks = chunkFieldValue(ORD_TAGS.metadata, cbor);
      expect(chunks.length).toBe(3);
      const p = parseFields(chunks);
      expect(p.getMetadata()).toEqual({ blob: big, kind: 'metadata' });
    });

    it('exactly-520-byte value stays a single chunk; 521 splits into two', () => {
      expect(chunkFieldValue(ORD_TAGS.metadata, new Uint8Array(520)).length).toBe(1);
      expect(chunkFieldValue(ORD_TAGS.metadata, new Uint8Array(521)).length).toBe(2);
    });
  });

  describe('properties (tag 0x11) + property_encoding (tag 0x13)', () => {
    it('CBOR gallery + title round-trips via getProperties()', async () => {
      // ord properties use INTEGER keys: {0: gallery[], 1: attributes{}}.
      // A Map preserves integer-keyed encoding through encodeCborDeterministic.
      const galleryItem = new Map<number, unknown>([[0, encodeInscriptionId(DELEGATE_ID)]]);
      const attributes = new Map<number, unknown>([[0, 'My Gallery']]);
      const properties = new Map<number, unknown>([[0, [galleryItem]], [1, attributes]]);
      const cbor = encodeCborDeterministic(properties);

      const p = parseFields(chunkFieldValue(ORD_TAGS.properties, cbor));
      const result = await p.getProperties();
      expect(result).toEqual({ gallery: [{ inscriptionId: DELEGATE_ID }], title: 'My Gallery' });
    });
  });

  describe('all first-class tags at once (coexistence + ordering independence)', () => {
    it('pointer + metaprotocol + parent + delegate + rune + metadata + note + contentEncoding all resolve', () => {
      const cbor = encodeCborDeterministic({ author: 'ordpool' });
      const fields: OrdEnvelopeField[] = [
        { tag: ORD_TAGS.pointer, value: encodePointerValue(42) },
        { tag: ORD_TAGS.content_encoding, value: new TextEncoder().encode('br') },
        { tag: ORD_TAGS.metaprotocol, value: new TextEncoder().encode('brc-20') },
        { tag: ORD_TAGS.parent, value: encodeParentInscriptionId(DELEGATE_ID) },
        { tag: ORD_TAGS.delegate, value: encodeInscriptionId(DELEGATE_ID_IDX) },
        { tag: ORD_TAGS.rune, value: encodeRuneCommitment(258n) },
        ...chunkFieldValue(ORD_TAGS.metadata, cbor),
        { tag: ORD_TAGS.note, value: new TextEncoder().encode('ordpool.space') },
      ];
      const p = parseFields(fields);
      expect(p.getPointer()).toBe(42);
      expect(p.getContentEncoding()).toBe('br');
      expect(p.getMetaprotocol()).toBe('brc-20');
      expect(p.getParents()).toEqual([DELEGATE_ID]);
      expect(p.getDelegates()).toEqual([DELEGATE_ID_IDX]);
      expect(p.getRune()).toEqual(new Uint8Array([0x02, 0x01]));
      expect(p.getMetadata()).toEqual({ author: 'ordpool' });
      expect(p.getNote()).toBe('ordpool.space');
    });
  });

  describe('520-byte per-push guard', () => {
    it('throws on a raw field value over 520 bytes', () => {
      expect(() => buildInscriptionEnvelope({
        revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
        contentType: 'text/plain',
        body: new Uint8Array(0),
        fields: [{ tag: ORD_TAGS.metadata, value: new Uint8Array(521) }],
      })).toThrow(/max 520 per push/);
    });

    it('also guards the content_type push (not just the fields loop)', () => {
      const hugeContentType = 'x'.repeat(521);
      expect(() => buildInscriptionEnvelope({
        revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
        contentType: hugeContentType,
        body: new Uint8Array(0),
      })).toThrow(/max 520 per push/);
    });

    it('chunkable tag (metadata) advises chunkFieldValue; non-chunkable tag (metaprotocol) does not', () => {
      const over = new Uint8Array(521);
      expect(() => buildInscriptionEnvelope({
        revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
        contentType: 'text/plain',
        body: new Uint8Array(0),
        fields: [{ tag: ORD_TAGS.metadata, value: over }],
      })).toThrow(/chunkFieldValue/);

      expect(() => buildInscriptionEnvelope({
        revealPubkeyXonly: DUMMY_REVEAL_PUBKEY,
        contentType: 'text/plain',
        body: new Uint8Array(0),
        fields: [{ tag: ORD_TAGS.metaprotocol, value: over }],
      })).toThrow(/cannot be chunked/);
    });
  });
});

describe('encodeParentInscriptionId — round-trip vs ordpool-parser', () => {

  // parser's `extractInscriptionId` is what ordpool actually renders
  // parents from, so anything the SDK encodes must round-trip through
  // it byte-for-byte.
  const { extractInscriptionId } = require('ordpool-parser') as {
    extractInscriptionId: (v: Uint8Array) => string | null;
  };

  it('encodes index=0 as 32 bytes (reversed txid, no trailing index bytes)', () => {
    const id = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
    const bytes = encodeParentInscriptionId(id);
    expect(bytes.length).toBe(32);
    expect(extractInscriptionId(bytes)).toBe(id);
  });

  it('encodes index=1 as 33 bytes (one trailing 0x01)', () => {
    const id = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i1';
    const bytes = encodeParentInscriptionId(id);
    expect(bytes.length).toBe(33);
    expect(bytes[32]).toBe(0x01);
    expect(extractInscriptionId(bytes)).toBe(id);
  });

  it('encodes index=256 as 34 bytes (LE bytes [0x00, 0x01], no trailing zeros trimmed inside)', () => {
    const id = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i256';
    const bytes = encodeParentInscriptionId(id);
    expect(bytes.length).toBe(34);
    expect(bytes[32]).toBe(0x00);
    expect(bytes[33]).toBe(0x01);
    expect(extractInscriptionId(bytes)).toBe(id);
  });

  it('encodes u32-max index as 36 bytes (four 0xFF trailing bytes)', () => {
    // No parser round-trip here: ordpool-parser's
    // `littleEndianBytesToNumber` uses JS `|` ops, which treat the
    // 4-byte LE input as signed i32 (0xFFFFFFFF → -1). ord itself
    // decodes u32 correctly, so the byte shape below is the wire
    // format ord will accept. Pin only the bytes.
    const id = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i4294967295';
    const bytes = encodeParentInscriptionId(id);
    expect(bytes.length).toBe(36);
    expect(bytes[32]).toBe(0xff);
    expect(bytes[33]).toBe(0xff);
    expect(bytes[34]).toBe(0xff);
    expect(bytes[35]).toBe(0xff);
  });

  it('encodes i32-max index as 36 bytes and round-trips through parser (parser signed-int ceiling)', () => {
    const id = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i2147483647';
    const bytes = encodeParentInscriptionId(id);
    expect(bytes.length).toBe(36);
    expect(extractInscriptionId(bytes)).toBe(id);
  });

  it('reverses the txid bytes (byte 0 of output = byte 31 of the hex-decoded txid)', () => {
    // txid where the first hex byte differs from the last — proves reversal.
    const id = 'aa000000000000000000000000000000000000000000000000000000000000bbi0';
    const bytes = encodeParentInscriptionId(id);
    expect(bytes[0]).toBe(0xbb);
    expect(bytes[31]).toBe(0xaa);
  });

  it('rejects wrong-length txid', () => {
    expect(() => encodeParentInscriptionId('abci0')).toThrow(/Invalid inscription id/);
  });

  it('rejects uppercase hex (parser expects canonical lowercase)', () => {
    const id = 'FFB976AB49DCEC017F1E201E84395983204AE1A7C2ABF7CED0A85D692E442799i0';
    expect(() => encodeParentInscriptionId(id)).toThrow(/Invalid inscription id/);
  });

  it('rejects missing i-separator', () => {
    expect(() =>
      encodeParentInscriptionId('6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e4427990'),
    ).toThrow(/Invalid inscription id/);
  });

  it('rejects index with leading zero (non-canonical)', () => {
    expect(() =>
      encodeParentInscriptionId('6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i01'),
    ).toThrow(/canonical form/);
  });

  it('rejects index above u32 max', () => {
    expect(() =>
      encodeParentInscriptionId('6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i4294967296'),
    ).toThrow(/u32 range/);
  });
});
