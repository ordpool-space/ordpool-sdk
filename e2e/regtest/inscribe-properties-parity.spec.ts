/**
 * Byte-parity for ord's `properties` field (envelope tag 0x11): galleries and
 * titles, against live `ord wallet inscribe --gallery … --title …`.
 *
 * Why this needs a live comparison rather than a unit test: ord does not
 * write a gallery as a list of inscription ids. `Properties::to_packed_cbor`
 * strips each item's id, concatenates the raw 32-byte txids into ONE byte
 * string, and keeps only a non-zero inscription index per item. A
 * reasonable-looking id array encodes to completely different bytes and would
 * pass any test we wrote against our own assumption. Only ord's own output
 * settles it.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { ORD_TAGS, buildInscriptionEnvelope } from '../../src/inscribe/inscription-envelope';
import { packInscriptionProperties } from '../../src/inscribe/inscription-properties';
import { synthesizeEnvelopeFields } from '../../src/inscribe/inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from '../../src/inscribe/inscription.service.helper';
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

const ORD_WALLET = 'parity-properties-stock';
const TXT = 'text/plain;charset=utf-8';

function ordEnvelopePostPubkey(revealTxid: string): string {
  const tx = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', revealTxid)));
  return hex.encode(tx.getInput(0).finalScriptWitness![1]).slice(68);
}

function sdkEnvelopePostPubkey(body: Uint8Array, properties: Uint8Array | undefined): string {
  const env = buildInscriptionEnvelope({
    revealPubkeyXonly: new Uint8Array(32).fill(7),
    contentType: TXT,
    body,
    fields: properties ? [{ tag: ORD_TAGS.properties, value: properties }] : [],
  });
  return hex.encode(env).slice(68);
}

/**
 * Inscribe something plain with ord so we have real inscription ids to put in
 * a gallery. Mines and syncs afterwards: ord's wallet will not spend its own
 * unconfirmed change, so a second inscribe straight after the first finds no
 * cardinal utxo.
 */
async function ordInscribePlain(label: string): Promise<string> {
  const body = new TextEncoder().encode(label);
  writeOrdStockFile(`/tmp/${label}.txt`, body);
  const { reveal } = ordStockWalletInscribe(ORD_WALLET, `/tmp/${label}.txt`, 5);
  await waitForOrdStockSync(mineBlocks(1));
  return `${reveal}i0`;
}

describe('inscribe properties → byte-parity with stock ord', () => {
  let galleryA: string;
  let galleryB: string;

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    const ordAddr = ordStockCreateWallet(ORD_WALLET);
    // Coinbase outputs mature at 100 confirmations, so 101 blocks leaves
    // exactly ONE spendable utxo. This suite inscribes seven times with ord,
    // so it needs several mature coinbases before the first one.
    rpc('generatetoaddress', '110', ordAddr);
    const tip = Number(rpc('getblockcount'));
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);

    galleryA = await ordInscribePlain('gallery-a');
    galleryB = await ordInscribePlain('gallery-b');
  }, 240_000);

  it('a TITLE is byte-identical to `ord wallet inscribe --title`', async () => {
    const body = new TextEncoder().encode('parity: title only');
    writeOrdStockFile('/tmp/parity-title.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-title.txt', 5, [
      '--title', 'My Piece',
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    const sdk = sdkEnvelopePostPubkey(body, packInscriptionProperties({ title: 'My Piece' }));
    expect(sdk).toBe(ordEnvelopePostPubkey(reveal));
  }, 120_000);

  it('a ONE-ITEM gallery is byte-identical to `ord wallet inscribe --gallery`', async () => {
    const body = new TextEncoder().encode('parity: one gallery item');
    writeOrdStockFile('/tmp/parity-g1.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-g1.txt', 5, [
      '--gallery', galleryA,
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    const sdk = sdkEnvelopePostPubkey(body, packInscriptionProperties({ gallery: [galleryA] }));
    expect(sdk).toBe(ordEnvelopePostPubkey(reveal));
  }, 120_000);

  it('a TWO-ITEM gallery matches, which is where the packed txid table shows up', async () => {
    // Two items means a 64-byte txid string under key 2 and two item maps
    // under key 0. If our encoding wrote ids per item instead, one item would
    // still be wrong but two makes the shape unmistakable.
    const body = new TextEncoder().encode('parity: two gallery items');
    writeOrdStockFile('/tmp/parity-g2.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-g2.txt', 5, [
      '--gallery', galleryA,
      '--gallery', galleryB,
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    const sdk = sdkEnvelopePostPubkey(
      body,
      packInscriptionProperties({ gallery: [galleryA, galleryB] }),
    );
    expect(sdk).toBe(ordEnvelopePostPubkey(reveal));
  }, 120_000);

  it('a gallery AND a title together match, so the key order is right', async () => {
    const body = new TextEncoder().encode('parity: gallery and title');
    writeOrdStockFile('/tmp/parity-gt.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-gt.txt', 5, [
      '--gallery', galleryA,
      '--title', 'Both At Once',
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    const sdk = sdkEnvelopePostPubkey(
      body,
      packInscriptionProperties({ gallery: [galleryA], title: 'Both At Once' }),
    );
    expect(sdk).toBe(ordEnvelopePostPubkey(reveal));
  }, 120_000);

  it('no gallery and no title emits NO properties tag at all, as ord does', async () => {
    const body = new TextEncoder().encode('parity: nothing');
    writeOrdStockFile('/tmp/parity-none.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-none.txt', 5);
    await waitForOrdStockSync(mineBlocks(1));

    expect(packInscriptionProperties({})).toBeUndefined();
    expect(sdkEnvelopePostPubkey(body, undefined)).toBe(ordEnvelopePostPubkey(reveal));
  }, 120_000);
  it('the TYPED gallery/title inputs, through the real field synthesis, match ord', async () => {
    // The tests above call the packer directly. Consumers never do: they pass
    // { gallery, title } and synthesizeEnvelopeFields builds the envelope.
    // This proves that wiring produces ord's bytes, not just the packer.
    const body = new TextEncoder().encode('parity: typed inputs end to end');
    writeOrdStockFile('/tmp/parity-typed.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-typed.txt', 5, [
      '--gallery', galleryA,
      '--gallery', galleryB,
      '--title', 'Typed',
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    const fields = synthesizeEnvelopeFields({
      gallery: [galleryA, galleryB],
      title: 'Typed',
    } as unknown as CreateInscribeTransactionsArgs);
    const env = buildInscriptionEnvelope({
      revealPubkeyXonly: new Uint8Array(32).fill(7),
      contentType: TXT,
      body,
      fields,
    });
    expect(hex.encode(env).slice(68)).toBe(ordEnvelopePostPubkey(reveal));
  }, 120_000);
});
