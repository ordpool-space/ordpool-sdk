/**
 * `--compress` parity: does the SDK's brotli produce ord's bytes?
 *
 * ord compresses with the Rust `brotli` crate at quality 11, lgwin 24,
 * lgblock 24, a mode chosen from the content type, and size_hint = input
 * length, and keeps the result only if it is strictly smaller than the input
 * (cat21-ord/src/inscriptions/inscription.rs, `Inscription::compress`).
 *
 * brotli-wasm 3.0.1, which the SDK uses, exposes only `quality`. lgwin in
 * particular is written into the brotli stream header, so a different window
 * changes the bytes even for a tiny input. This spec exists to settle that
 * against ord rather than by reading library signatures.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { compressBrotliWasm } from '../../src/inscribe/brotli-wasm-encoder';
import {
  mineBlocks,
  ordStockCreateWallet,
  ordStockWalletInscribe,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  writeOrdStockFile,
} from './regtest-helpers';

const ORD_WALLET = 'parity-compress-stock';
const WASM = readFileSync(join(__dirname, '../../wasm/brotli_wasm_bg.wasm'));

/** Pull the body pushes (everything after OP_0 up to OP_ENDIF) out of ord's envelope. */
function ordBody(revealTxid: string): Uint8Array {
  const tx = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', revealTxid)));
  const script = btc.Script.decode(tx.getInput(0).finalScriptWitness![1]);
  const zero = script.findIndex((op, i) => i > 2 && (op === 0 || op === 'OP_0'));
  const end = script.findIndex(op => op === 'ENDIF');
  const parts = script.slice(zero + 1, end).filter((p): p is Uint8Array => p instanceof Uint8Array);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('inscribe --compress → brotli parity with stock ord', () => {
  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    const ordAddr = ordStockCreateWallet(ORD_WALLET);
    rpc('generatetoaddress', '110', ordAddr);
    const tip = Number(rpc('getblockcount'));
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);
  }, 240_000);

  // KNOWN GAP, recorded rather than hidden. Measured 2026-09-11: the bodies
  // differ in exactly ONE byte, the first, which is the brotli stream
  // header's WBITS. SDK 0x1b decodes to lgwin 22 (brotli-wasm's default);
  // ord 0x1f decodes to lgwin 24. Every other byte already matches, because
  // brotli-wasm is built from the same Rust `brotli` crate ord uses.
  //
  // brotli-wasm 3.0.1 exposes only `quality`, so lgwin cannot be set from
  // here. The fix is to build the wasm from the pinned crate with lgwin,
  // lgblock, mode and size_hint exposed. Rewriting the header byte would
  // match this input and quietly diverge on any input where the mode or the
  // window changes the payload too, so it is not done.
  //
  // `it.failing` keeps the lane green while the gap stands, and turns RED the
  // moment the bytes match, which is the signal to drop `.failing`.
  it.failing('the compressed body is byte-identical to ord --compress (text)', async () => {
    // Repetitive enough that brotli wins, so ord keeps the compressed form.
    const body = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(40));
    writeOrdStockFile('/tmp/parity-compress.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-compress.txt', 5, ['--compress']);
    await waitForOrdStockSync(mineBlocks(1));

    const ordCompressed = ordBody(reveal);
    expect(ordCompressed.length).toBeLessThan(body.length); // ord did keep the compressed form

    const sdkCompressed = await compressBrotliWasm(body, 11, WASM);
    expect(hex.encode(sdkCompressed)).toBe(hex.encode(ordCompressed));
  }, 120_000);
});
