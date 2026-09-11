/**
 * Metadata and delegate parity with `ord wallet inscribe`.
 *
 *   --cbor-metadata <FILE>   ord embeds the file's bytes as-is (tag 0x05)
 *   --json-metadata <FILE>   ord converts the JSON to CBOR itself
 *   --delegate <ID>          ord points at another inscription's body (tag 0x0b)
 *
 * The JSON case is the one with a real question in it. ord parses with
 * serde_json built with `preserve_order` (cat21-ord/Cargo.toml), so object
 * keys keep the order they have in the FILE, and ciborium writes them in that
 * order. The SDK's encodeCborDeterministic SORTS keys by their encoded bytes.
 * The two agree only when the source happens to be sorted already.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { buildInscriptionEnvelope, type OrdEnvelopeField } from '../../src/inscribe/inscription-envelope';
import { encodeJsonMetadata } from '../../src/inscribe/inscription-json-metadata';
import { createInscribeTransactions, synthesizeEnvelopeFields } from '../../src/inscribe/inscription.service.helper';
import { Network } from '../../src/network';
import type { CreateInscribeTransactionsArgs } from '../../src/inscribe/inscription.service.helper';
import {
  fundUninscribed,
  getStockOrdContent,
  mineBlocks,
  postTx,
  waitForOrdStockInscription,
  fundOrdStockWallet,
  ordStockWalletInscribe,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  writeOrdStockFile,
} from './regtest-helpers';

// A fresh ord wallet per run. Every inscribe deposits into ord's own wallet,
// and reusing a wallet across runs grows a UTXO pool that eventually trips
// ord's coin-selection invariant (transaction_builder.rs, checked_sub on
// Target::Value). CI starts from a fresh stack; a reused local stack does not.
const ORD_WALLET = `parity-meta-stock-${Date.now().toString(36)}`;
const TXT = 'text/plain;charset=utf-8';

function ordEnvelope(revealTxid: string): string {
  const tx = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', revealTxid)));
  return hex.encode(tx.getInput(0).finalScriptWitness![1]).slice(68);
}

function sdkEnvelope(body: Uint8Array | undefined, contentType: string | undefined, fields: OrdEnvelopeField[]): string {
  return hex.encode(buildInscriptionEnvelope({
    revealPubkeyXonly: new Uint8Array(32).fill(7),
    contentType,
    body,
    fields,
  } as Parameters<typeof buildInscriptionEnvelope>[0])).slice(68);
}

function fields(args: Partial<CreateInscribeTransactionsArgs>): OrdEnvelopeField[] {
  return synthesizeEnvelopeFields(args as CreateInscribeTransactionsArgs);
}

describe('inscribe metadata and delegate → byte-parity with stock ord', () => {
  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await fundOrdStockWallet(ORD_WALLET);
  }, 240_000);

  it('--cbor-metadata: the same CBOR bytes produce the same envelope', async () => {
    const body = new TextEncoder().encode('parity: cbor metadata');
    // A map written in NON-sorted key order, so this also shows ord embeds
    // the file verbatim rather than re-encoding it.
    const cbor = hex.decode('a2646e616d6564437562656361676501'); // {"name":"Cube","age":1}
    writeOrdStockFile('/tmp/parity-cbor.txt', body);
    writeOrdStockFile('/tmp/parity-cbor.cbor', cbor);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-cbor.txt', 5, [
      '--cbor-metadata', '/tmp/parity-cbor.cbor',
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    expect(sdkEnvelope(body, TXT, fields({ metadata: cbor }))).toBe(ordEnvelope(reveal));
  }, 120_000);

  // Each fixture isolates one way a generic JSON-to-CBOR converter differs
  // from ord's serde_json(preserve_order) + ciborium. ord is the authority for
  // every one of them; none is asserted from our own reading.
  it.each([
    ['key order is the FILE order, not sorted', '{"name":"Cube","age":1}'],
    ['an integer-like key stays where it was written', '{"b":1,"1":2}'],
    ['1 and 1.0 are different types; floats shrink to f16', '{"z":1,"y":1.0,"x":1.5}'],
    ['negatives, and -0 is the float -0.0', '{"n":-3,"neg0":-0}'],
    ['u64 max stays an integer', '{"big":18446744073709551615}'],
    ['a value only f64 can hold', '{"tiny":0.1}'],
    ['a value f32 holds but f16 cannot', '{"f":100000.0}'],
    ['nesting, arrays, literals, escapes, unicode', '{"s":"é\\n\\"q\\"","a":[true,false,null,{"k":[]}]}'],
    ['a duplicate key keeps its FIRST position and LAST value', '{"a":1,"b":2,"a":3}'],
  ])('--json-metadata: %s', async (_label, json) => {
    const tag = Buffer.from(json).toString('hex').slice(0, 16);
    const body = new TextEncoder().encode(`parity: json ${tag}`);
    const path = `/tmp/parity-json-${tag}`;
    writeOrdStockFile(`${path}.txt`, body);
    writeOrdStockFile(`${path}.json`, new TextEncoder().encode(json));
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, `${path}.txt`, 5, [
      '--json-metadata', `${path}.json`,
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    const sdk = sdkEnvelope(body, TXT, fields({ metadata: encodeJsonMetadata(json) }));
    expect(sdk).toBe(ordEnvelope(reveal));
  }, 120_000);

  it('--delegate with no file: the envelope is byte-identical to ord', async () => {
    writeOrdStockFile('/tmp/parity-delegate-target.txt', new TextEncoder().encode('delegated content'));
    const target = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-delegate-target.txt', 5);
    await waitForOrdStockSync(mineBlocks(1));
    const delegateId = `${target.reveal}i0`;

    // ord's inscribe requires --file OR --delegate; this is delegate alone.
    const { reveal } = ordStockWalletInscribeDelegateOnly(delegateId);
    await waitForOrdStockSync(mineBlocks(1));

    expect(sdkEnvelope(undefined, undefined, fields({ delegate: delegateId }))).toBe(ordEnvelope(reveal));
  }, 120_000);
});

describe('SDK delegate-only inscription on chain', () => {
  it('broadcasts with no body, and stock ord serves the delegate\'s content for it', async () => {
    await waitForOrdStockReady(60_000);
    const wallet = `${ORD_WALLET}-sdk`;
    await fundOrdStockWallet(wallet);
    const content = new TextEncoder().encode('content an SDK delegate points at');
    writeOrdStockFile('/tmp/parity-sdk-delegate-target.txt', content);
    const target = ordStockWalletInscribe(wallet, '/tmp/parity-sdk-delegate-target.txt', 5);
    await waitForOrdStockSync(mineBlocks(1));
    const delegateId = `${target.reveal}i0`;

    const f = await fundUninscribed();
    const built = createInscribeTransactions({
      paymentOutput: { ...f.utxo, status: { confirmed: true } },
      paymentPublicKey: f.fundingPubkey,
      paymentAddress: f.fundingAddr,
      recipientAddress: f.fundingAddr,
      delegate: delegateId,
      feeRatePerVbyte: 5,
      network: Network.Regtest,
    });
    const processed = JSON.parse(rpc(
      '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
      `psbt=${base64.encode(built.commitPsbt)}`, 'sign=true', 'finalize=true',
    )) as { hex: string };
    expect(await postTx(processed.hex)).toBe(built.commitTxid);
    expect(await postTx(built.revealHex)).toBe(built.revealTxid);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);

    const id = `${built.revealTxid}i0`;
    const insc = await waitForOrdStockInscription(id) as unknown as {
      content_type: string | null; effective_content_type: string | null;
    };
    expect(insc.content_type).toBeNull();
    expect(insc.effective_content_type).toBe('text/plain;charset=utf-8');
    expect((await getStockOrdContent(id)).bytes).toEqual(content);
  }, 240_000);
});

/** `ord wallet inscribe --delegate <ID>` with no --file, which the shared helper cannot express. */
function ordStockWalletInscribeDelegateOnly(delegateId: string): { reveal: string } {
  const out = execFileSync('docker', [
    'exec', 'ordpool-e2e-ord-stock', 'ord', '--regtest', '--index-sats', '--index-addresses',
    '--bitcoin-rpc-url=bitcoind:18443', '--bitcoin-rpc-username=ordpool', '--bitcoin-rpc-password=ordpool',
    '--data-dir=/data', 'wallet', '--no-sync', '--name', ORD_WALLET, '--server-url', 'http://localhost:8080',
    'inscribe', '--no-backup', '--fee-rate', '5', '--delegate', delegateId,
  ], { encoding: 'utf8' });
  return { reveal: (JSON.parse(out) as { reveal: string }).reveal };
}
