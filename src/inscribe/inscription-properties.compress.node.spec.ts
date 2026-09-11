/**
 * @jest-environment node
 *
 * Compressed properties, ord's `--compress` rule. Byte-parity with ord is
 * proven on regtest in e2e/regtest/inscribe-compress-parity.spec.ts; these
 * pin the candidate rule and the refusals without a chain.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { hex } from '@scure/base';

import { loadBrotliWasm } from './brotli-wasm-encoder';
import { ORD_TAGS } from './inscription-envelope';
import { encodeInscriptionProperties, packInscriptionProperties } from './inscription-properties';
import { synthesizeEnvelopeFields } from './inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from './inscription.service.helper';

const WASM = readFileSync(join(__dirname, '../../wasm/brotli_wasm_bg.wasm'));
// Hash-derived txids: as incompressible as real ones.
const ID = (n: number) => `${createHash('sha256').update(String(n)).digest('hex')}i0`;

// Runs first: jest runs describe blocks in order, and the next block's
// beforeAll loads the wasm.
describe('compressed properties before the wasm is loaded', () => {
  it('fails with the fix in the message instead of silently skipping compression', () => {
    expect(() => encodeInscriptionProperties({ gallery: [ID(1)] }, { compress: true }))
      .toThrow('the brotli wasm is not loaded; await loadBrotliWasm(source) first');
  });
});

describe('compressed properties', () => {
  beforeAll(async () => {
    await loadBrotliWasm(WASM);
  });

  it('a compressed candidate wins when it is the smallest, and decompresses to the packed form', () => {
    const input = { gallery: Array(8).fill(ID(1)), title: 'eight of one' };
    const encoded = encodeInscriptionProperties(input, { compress: true });
    expect(encoded?.propertyEncoding).toBe('br');
    // Of the two compressed forms, the packed one is smaller here.
    expect(hex.encode(new Uint8Array(brotliDecompressSync(Buffer.from(encoded!.properties)))))
      .toBe(hex.encode(packInscriptionProperties(input)!));
  });

  it('plain wins when compression does not beat it, so no encoding is set', () => {
    const input = { gallery: [ID(1), ID(2), ID(3)], title: 'three distinct' };
    const encoded = encodeInscriptionProperties(input, { compress: true });
    expect(encoded?.propertyEncoding).toBeUndefined();
    expect(hex.encode(encoded!.properties)).toBe(hex.encode(packInscriptionProperties(input)!));
  });

  it('refuses a compression ratio over 30:1, as ord does', () => {
    expect(() => encodeInscriptionProperties({ gallery: Array(200).fill(ID(1)) }, { compress: true }))
      .toThrow('property compression over 30:1');
  });

  it('the builder emits tag 0x13 = br right after the compressed properties', () => {
    const fields = synthesizeEnvelopeFields({
      gallery: Array(8).fill(ID(1)),
      title: 'eight of one',
      compressProperties: true,
    } as unknown as CreateInscribeTransactionsArgs);
    const tags = fields.map(f => f.tag);
    const at = tags.indexOf(ORD_TAGS.property_encoding);
    expect(tags[at - 1]).toBe(ORD_TAGS.properties);
    expect(new TextDecoder().decode(fields[at].value)).toBe('br');
  });

  it('compressProperties with raw properties bytes is refused, since there is nothing typed to compress', () => {
    expect(() => synthesizeEnvelopeFields({
      properties: new Uint8Array([0xa0]),
      compressProperties: true,
    } as unknown as CreateInscribeTransactionsArgs)).toThrow('compressProperties applies to gallery/title only');
  });
});
