/**
 * `--compress` parity: the SDK compresses exactly as `ord wallet inscribe
 * --compress` does, proven by comparing whole envelopes against live ord.
 *
 * ord compresses with the Rust `brotli` crate at quality 11, lgwin 24,
 * lgblock 24, a mode chosen from the content type, and size_hint = input
 * length, and keeps the result only if it is strictly smaller than the input
 * (cat21-ord/src/inscriptions/inscription.rs, `Inscription::compress`).
 * `--compress` also adds brotli-compressed forms of the properties to the
 * candidates ord picks the smallest from (`encode_properties`), and refuses
 * properties that compress by more than 30:1.
 *
 * The SDK side is `compressLikeOrd` for the body and `compressProperties` on
 * the builder, both running the same crate compiled to wasm
 * (wasm-src/brotli-ord).
 *
 * The fixtures cover each brotli mode ord's media table uses (text, generic,
 * font), a body large enough to span several brotli blocks, a body ord
 * leaves uncompressed because brotli does not shrink it, and properties both
 * where compression wins and where it loses.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { ORD_TAGS, buildInscriptionEnvelope, type OrdEnvelopeField } from '../../src/inscribe/inscription-envelope';
import { loadBrotliWasm } from '../../src/inscribe/brotli-wasm-encoder';
import { compressLikeOrd } from '../../src/inscribe/inscribe-compression.helper';
import { synthesizeEnvelopeFields } from '../../src/inscribe/inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from '../../src/inscribe/inscription.service.helper';
import {
  mineBlocks,
  fundOrdStockWallet,
  ordStockWalletInscribe,
  rpc,
  waitForOrdStockReady,
  waitForOrdStockSync,
  writeOrdStockFile,
} from './regtest-helpers';

// A fresh ord wallet per run. Every inscribe deposits into ord's own wallet,
// and reusing a wallet across runs grows a UTXO pool that eventually trips
// ord's coin-selection invariant (transaction_builder.rs, checked_sub on
// Target::Value). CI starts from a fresh stack; a reused local stack does not.
const ORD_WALLET = `parity-compress-stock-${Date.now().toString(36)}`;
const WASM = readFileSync(join(__dirname, '../../wasm/brotli_wasm_bg.wasm'));
const enc = (s: string) => new TextEncoder().encode(s);

function ordEnvelope(revealTxid: string): string {
  const tx = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', revealTxid)));
  return hex.encode(tx.getInput(0).finalScriptWitness![1]).slice(68);
}

function sdkEnvelope(body: Uint8Array, contentType: string, fields: OrdEnvelopeField[]): string {
  return hex.encode(buildInscriptionEnvelope({
    revealPubkeyXonly: new Uint8Array(32).fill(7),
    contentType,
    body,
    fields,
  })).slice(68);
}

function fields(args: Partial<CreateInscribeTransactionsArgs>): OrdEnvelopeField[] {
  return synthesizeEnvelopeFields(args as CreateInscribeTransactionsArgs);
}

/** Text with enough variety that brotli's modes and block splits matter. */
function wordText(count: number): string {
  const words = 'cat sat block witness envelope ordinal satoshi inscription gallery parent child pointer metadata'.split(' ');
  let out = '';
  for (let i = 0; i < count; i++) out += words[(i * 7 + (i >> 3)) % words.length] + (i % 11 === 0 ? '.\n' : ' ');
  return out;
}

/** JSON with many distinct numbers: compressible, but not trivially. */
function mixedJson(rows: number): string {
  const items = [];
  for (let i = 0; i < rows; i++) {
    items.push({ n: i, sq: (i * i) % 9973, id: `cat-${(i * 2654435761) % 100000}`, ok: i % 3 === 0 });
  }
  return JSON.stringify(items);
}

describe('inscribe --compress → byte-parity with stock ord', () => {
  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await fundOrdStockWallet(ORD_WALLET);
    // The builder compresses properties synchronously, so the wasm must be loaded.
    await loadBrotliWasm(WASM);
  }, 240_000);

  // [label, file extension, the content type ord assigns that extension, body, ord compresses it?]
  it.each<[string, string, string, Uint8Array, boolean]>([
    ['text (text mode)', 'txt', 'text/plain;charset=utf-8', enc('the quick brown fox jumps over the lazy dog. '.repeat(40)), true],
    ['html (text mode)', 'html', 'text/html;charset=utf-8', enc('<html><body>' + '<p class="cube">cube</p>'.repeat(80) + '</body></html>'), true],
    ['json (text mode)', 'json', 'application/json', enc(mixedJson(200)), true],
    ['svg (text mode)', 'svg', 'image/svg+xml', enc('<svg xmlns="http://www.w3.org/2000/svg">' + '<rect x="1" y="2"/>'.repeat(60) + '</svg>'), true],
    ['javascript (text mode)', 'js', 'text/javascript', enc('function f(a){return a*2}\n'.repeat(50)), true],
    ['css (text mode)', 'css', 'text/css', enc('.cat{color:#f7931a;margin:0 auto}\n'.repeat(50)), true],
    ['binary (generic mode)', 'bin', 'application/octet-stream', new Uint8Array(4000).map((_, i) => (i * i * 7 + 13) & 0xff), true],
    ['woff2 (font mode)', 'woff2', 'font/woff2', enc(wordText(800)), true],
    ['a large body spanning several brotli blocks', 'json', 'application/json', enc(mixedJson(2500)), true],
    ['a body brotli does not shrink: ord keeps it as is', 'txt', 'text/plain;charset=utf-8', enc('hi'), false],
  ])('%s', async (label, ext, contentType, body, ordCompresses) => {
    const path = `/tmp/parity-compress-${label.replace(/[^a-z0-9]+/gi, '-')}.${ext}`;
    writeOrdStockFile(path, body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, path, 5, ['--compress']);
    await waitForOrdStockSync(mineBlocks(1));

    const sdk = await compressLikeOrd(body, contentType, WASM);
    expect(sdk.contentEncoding).toBe(ordCompresses ? 'br' : undefined);

    const envelope = sdkEnvelope(sdk.body, contentType, fields({ contentEncoding: sdk.contentEncoding }));
    expect(envelope).toBe(ordEnvelope(reveal));
  }, 180_000);

  describe('properties under --compress', () => {
    const ids: string[] = [];

    beforeAll(async () => {
      for (let i = 0; i < 3; i++) {
        writeOrdStockFile(`/tmp/parity-compress-item-${i}.txt`, enc(`gallery item ${i}`));
        const { reveal } = ordStockWalletInscribe(ORD_WALLET, `/tmp/parity-compress-item-${i}.txt`, 5);
        ids.push(`${reveal}i0`);
        await waitForOrdStockSync(mineBlocks(1));
      }
    }, 240_000);

    async function compareGallery(gallery: string[], title: string, expectCompressedProperties: boolean): Promise<void> {
      const body = enc(`parity: compressed gallery of ${gallery.length}`);
      const path = `/tmp/parity-compress-gallery-${gallery.length}.txt`;
      writeOrdStockFile(path, body);
      const { reveal } = ordStockWalletInscribe(ORD_WALLET, path, 5, [
        '--compress', '--title', title, ...gallery.flatMap(id => ['--gallery', id]),
      ]);
      await waitForOrdStockSync(mineBlocks(1));

      const sdkBody = await compressLikeOrd(body, 'text/plain;charset=utf-8', WASM);
      const sdkFields = fields({
        contentEncoding: sdkBody.contentEncoding,
        gallery,
        title,
        compressProperties: true,
      });
      expect(sdkFields.some(f => f.tag === ORD_TAGS.property_encoding)).toBe(expectCompressedProperties);
      expect(sdkEnvelope(sdkBody.body, 'text/plain;charset=utf-8', sdkFields)).toBe(ordEnvelope(reveal));
    }

    it('compressed properties win: the envelope, tag 0x13 included, is byte-identical to ord', async () => {
      // Eight entries of one id: the packed form repeats the same 32-byte
      // txid eight times, which brotli shrinks well below the plain forms.
      await compareGallery(Array(8).fill(ids[0]), 'eight of one', true);
    }, 180_000);

    it('compressed properties lose: ord and the SDK both ship them uncompressed', async () => {
      await compareGallery(ids, 'three distinct', false);
    }, 180_000);

    it('properties that compress over 30:1 are refused by ord and by the SDK alike', () => {
      const gallery = Array(200).fill(ids[0]);
      writeOrdStockFile('/tmp/parity-compress-ratio.txt', enc('ratio'));
      let ordError = '';
      try {
        ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-compress-ratio.txt', 5, [
          '--compress', ...gallery.flatMap(id => ['--gallery', id]),
        ]);
      } catch (err) {
        ordError = String((err as { stderr?: string }).stderr ?? err);
      }
      expect(ordError).toContain('property compression over 30:1');
      expect(() => fields({ gallery, compressProperties: true })).toThrow('property compression over 30:1');
    }, 180_000);
  });
});
