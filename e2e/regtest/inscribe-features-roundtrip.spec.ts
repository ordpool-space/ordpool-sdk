/**
 * Inscribe → cat21-ord-indexing roundtrip on regtest with the three
 * "day-one feature" additions:
 *
 *   1. nLockTime=21 on BOTH the commit AND the reveal → cat21-ord
 *      should see TWO cats stacked on the SAME satpoint (the
 *      inscription's UTXO).
 *   2. Tag::Note (0x0f) → ordpool-parser surfaces the watermark via
 *      the witness on the reveal tx.
 *   3. Brotli `content_encoding: br` → the witness carries the
 *      compressed body verbatim; `brotliDecompressSync` recovers
 *      the original.
 *
 * Only cat21-ord is needed here — the cat records prove the reveal
 * landed and its vout[0] is the recipient at 546 sats, and
 * ordpool-parser handles the inscription-bytes side. The "does real
 * upstream ord index our inscriptions" question is covered in a
 * separate spec (`inscribe-ord-indexing-roundtrip`); duplicating it
 * here would just add stock-ord startup time to every features run.
 *
 * Requires the cat21-ord profile in the regtest stack:
 *   docker compose -f e2e/docker-compose.regtest.yml \
 *     --profile cat21-ord up -d
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { gunzipSync } from 'node:zlib';
import { InscriptionParserService } from 'ordpool-parser';

import { assessCompression } from '../../src/inscribe/inscribe-compression.helper';
import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  catInscriptionId,
  EsploraTx,
  mineBlocks,
  postTx,
  rpc,
  waitForCatAtAddress,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC
const FEE_RATE = 5;
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

const PSBT_WALLET = 'ordpool-e2e';
function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

describe('inscribe day-one features roundtrip on regtest (cat + note + gzip)', () => {

  const scureRegtest = toScureNetwork(Network.Regtest);

  beforeAll(async () => {
    await waitForOrdReady(60_000);
  }, 90_000);

  it('nLockTime=21 lands a cat at the inscription recipient + note tag round-trips via parser', async () => {
    const recipientKey = secp256k1.utils.randomPrivateKey();
    const recipientAddress = btc.p2tr(schnorr.getPublicKey(recipientKey), undefined, scureRegtest, true).address!;

    const fundingPaymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingPaymentAddress));
    const fundingPaymentPublicKey = hex.decode(addrInfo.pubkey);

    bitcoinCliPsbtWallet('sendtoaddress', fundingPaymentAddress, '1.0');
    await waitForElectrsSync(mineBlocks(1));
    const utxo = await waitForUtxoAt(fundingPaymentAddress, FUND_AMOUNT_SATS);

    const bodyText = `inscribe-features: nLockTime21 + note @ ${new Date().toISOString()}`;
    const body = new TextEncoder().encode(bodyText);
    const NOTE = 'inscribed via ordpool.space';

    // Phase 1: build with note. The SDK auto-prepends a tag-15 (note)
    // envelope field and ALWAYS sets the commit's lockTime=21.
    const inscribed = createInscribeTransactions({
      paymentOutput: {
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        status: { confirmed: true },
      },
      paymentPublicKey: fundingPaymentPublicKey,
      paymentAddress: fundingPaymentAddress,
      recipientAddress,
      body,
      contentType: INSCRIPTION_CONTENT_TYPE,
      feeRatePerVbyte: FEE_RATE,
      note: NOTE,
      network: Network.Regtest,
    });

    // Phase 2: sign + broadcast commit.
    const unsignedCommitBase64 = base64.encode(inscribed.commitPsbt);
    const walletprocessed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt',
      `psbt=${unsignedCommitBase64}`,
      'sign=true',
      'finalize=true',
    ));
    expect(walletprocessed.complete).toBe(true);
    // Read the wire-tx from BC's `hex` field. Round-tripping a
    // BC-finalized PSBT through scure's fromPSBT + tx.hex emits a
    // wire-tx whose witness fails consensus on commit outputs that
    // carry a non-standard taproot tree (envelope leaf). BC's
    // extracted hex is authoritative.
    const signedCommit = btc.Transaction.fromRaw(hex.decode(walletprocessed.hex));

    // Pin the commit's lockTime ON THE WIRE to 21 — proves the
    // free-cat behaviour survives wallet signing.
    expect(signedCommit.lockTime).toBe(21);

    const commitTxid = await postTx(signedCommit.hex);
    expect(commitTxid).toBe(inscribed.commitTxid);
    // waitForElectrsSync + getTxStatus is racy (block header ingested
    // before per-tx status catches up). waitForTxConfirmed polls
    // per-tx directly.
    mineBlocks(1);
    await waitForTxConfirmed(commitTxid);

    // Phase 3: broadcast reveal + confirm.
    const revealTxid = await postTx(inscribed.revealHex);
    const revealTip = mineBlocks(1);
    await waitForElectrsSync(revealTip);
    const revealTx: EsploraTx = await waitForTxConfirmed(revealTxid);
    expect(revealTx.status.block_hash).toBeTruthy();

    // Phase 4: pin the reveal also carries lockTime=21 on the wire —
    // the SECOND-cat behaviour. Both commit AND reveal qualify as
    // CAT-21 mints under cat21-ord's --index-cat21 rule.
    expect(revealTx.locktime).toBe(21);

    // Phase 5: cat21-ord must surface TWO cats:
    //
    //   Cat A: id <commitTxid>i0 — fell out of nLockTime=21 on the
    //     commit. Currently at the first sat of vout[0] of the commit,
    //     which the reveal spent FIFO-style → moves to the reveal's
    //     vout[0] = inscription recipient at 546 sats.
    //
    //   Cat B: id <revealTxid>i0 — fell out of nLockTime=21 on the
    //     reveal. Minted on the first sat of vout[0] of the reveal —
    //     the SAME sat as cat A. Post-jubilee (regtest block ≥ 110)
    //     it carries the Vindicated charm but is a fully normal cat.
    //
    // Both must report the inscription recipient as their owner, and
    // both must point at the same satpoint (the reveal's vout[0]).
    await waitForOrdSync(revealTip);
    const catAId = catInscriptionId(commitTxid);   // <commitTxid>i0
    const catBId = catInscriptionId(revealTxid);   // <revealTxid>i0
    const catA = await waitForCatAtAddress(catAId, recipientAddress, 30_000);
    const catB = await waitForCatAtAddress(catBId, recipientAddress, 30_000);
    expect(catA.address).toBe(recipientAddress);
    expect(catB.address).toBe(recipientAddress);
    // Same UTXO: ord's `output` field is `<txid>:<vout>`. Both cats
    // live at the reveal's vout[0] which is also the inscription's UTXO.
    // Both cats live at the SAME satpoint: the first sat (offset 0)
    // of the reveal's vout[0]. ord's `/inscription/<id>` JSON exposes
    // this as `satpoint = <txid>:<vout>:<offset>`.
    const expectedSatpoint = `${revealTxid}:0:0`;
    expect(catA.satpoint).toBe(expectedSatpoint);
    expect(catB.satpoint).toBe(expectedSatpoint);
    // Same sat: cat21-ord exposes the sat number on each cat record.
    // Both cats live at the same satpoint (offset 0 of the reveal's
    // vout[0]), so their sat numbers MUST match. --index-sats is on
    // per docker-compose.regtest.yml, so a null/undefined here would
    // mean cat21-ord regressed silently — fail instead of skip.
    expect(typeof catA.sat).toBe('number');
    expect(typeof catB.sat).toBe('number');
    expect(catB.sat).toBe(catA.sat);
    // Distinct cat numbers — they're different cats, even on the
    // same sat. Cat A was minted in an earlier block (commit tip),
    // cat B in a later block (reveal tip), so cat A's number < cat B's.
    expect(catA.number).not.toBe(catB.number);
    expect(catB.number).toBeGreaterThan(catA.number);

    // Phase 6: inscription bytes round-trip via ordpool-parser. The
    // cat21-ord checks above already prove the reveal landed and its
    // vout[0] is the recipient; the parser closes the loop on the
    // inscription envelope.
    const witnessHex = (revealTx as unknown as { vin: { witness: string[] }[] }).vin[0].witness;
    const parsed = InscriptionParserService.parse({
      txid: revealTxid,
      vin: [{ witness: witnessHex }],
    });
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBe(INSCRIPTION_CONTENT_TYPE);
    const recoveredBody = new TextDecoder().decode(parsed[0].getDataRaw());
    expect(recoveredBody).toBe(bodyText);
    // The parser surfaces all known ord tags via `fields: { tag, value }[]`.
    // Tag 0x0f is the note tag. The whole point of this spec is
    // "consumer apps can read the watermark from parsed fields" —
    // silently skipping when the parser drops the tag is exactly the
    // failure mode this test should catch. Assert the tag IS present
    // and its decoded value matches the NOTE we wrote.
    const fields = (parsed[0] as unknown as { fields: { tag: number; value: Uint8Array }[] }).fields;
    const noteField = fields.find(f => f.tag === 0x0f);
    expect(noteField).toBeDefined();
    expect(new TextDecoder().decode(noteField!.value)).toBe(NOTE);
    // Additionally: the raw witness must contain the note bytes.
    // Defensive belt + parser-side braces — catches a case where
    // the parser exposes the tag but with corrupted bytes.
    const allWitnessHex = witnessHex.join('');
    const noteHex = Array.from(new TextEncoder().encode(NOTE))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    expect(allWitnessHex).toContain(noteHex);
  }, 240_000);

  it('gzip-compressed body round-trips on chain (compressed bytes in the witness, content_encoding: gzip tag)', async () => {
    const recipientKey = secp256k1.utils.randomPrivateKey();
    const recipientAddress = btc.p2tr(schnorr.getPublicKey(recipientKey), undefined, scureRegtest, true).address!;

    const fundingPaymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingPaymentAddress));
    const fundingPaymentPublicKey = hex.decode(addrInfo.pubkey);

    bitcoinCliPsbtWallet('sendtoaddress', fundingPaymentAddress, '1.0');
    await waitForElectrsSync(mineBlocks(1));
    const utxo = await waitForUtxoAt(fundingPaymentAddress, FUND_AMOUNT_SATS);

    // Realistic HTML-ish body that gzip compresses well.
    const original = new TextEncoder().encode(
      '<html><body>' + 'tip the maintainer '.repeat(200) + '</body></html>',
    );
    // Run the consumer-facing decision helper: it reports the savings and
    // hands back the compressed bytes to reuse (never compresses twice).
    const assessment = await assessCompression(original, 'text/html');
    expect(assessment.worthIt).toBe(true);
    expect(assessment.bestEncoding).toBe('gzip');
    expect(assessment.compressedSize).toBeLessThan(assessment.originalSize);
    const compressed = assessment.compressed;

    // Phase 1: build with the COMPRESSED body + contentEncoding flag.
    const inscribed = createInscribeTransactions({
      paymentOutput: {
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        status: { confirmed: true },
      },
      paymentPublicKey: fundingPaymentPublicKey,
      paymentAddress: fundingPaymentAddress,
      recipientAddress,
      body: compressed,
      contentType: 'text/html',
      feeRatePerVbyte: FEE_RATE,
      // 'none' → no tag; otherwise pass the winning codec. This is the
      // exact wiring a consumer (the inscribe UI) uses.
      contentEncoding: assessment.bestEncoding === 'none' ? undefined : assessment.bestEncoding,
      network: Network.Regtest,
    });

    // Phase 2: sign + broadcast commit.
    const unsignedCommitBase64 = base64.encode(inscribed.commitPsbt);
    const walletprocessed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt',
      `psbt=${unsignedCommitBase64}`,
      'sign=true',
      'finalize=true',
    ));
    expect(walletprocessed.complete).toBe(true);
    // See above for why we use walletprocessed.hex directly.
    const signedCommit = btc.Transaction.fromRaw(hex.decode(walletprocessed.hex));
    const commitTxid = await postTx(signedCommit.hex);
    expect(commitTxid).toBe(inscribed.commitTxid);
    await waitForElectrsSync(mineBlocks(1));

    // Phase 3: broadcast reveal + confirm.
    const revealTxid = await postTx(inscribed.revealHex);
    const revealTip = mineBlocks(1);
    await waitForElectrsSync(revealTip);
    const revealTx: EsploraTx = await waitForTxConfirmed(revealTxid);

    // Phase 4: parse the inscription out of the reveal's witness.
    // ordpool-parser sees the body as the on-chain bytes, which is
    // the COMPRESSED gzip output we built with.
    const witnessHex = (revealTx as unknown as { vin: { witness: string[] }[] }).vin[0].witness;
    const parsed = InscriptionParserService.parse({
      txid: revealTxid,
      vin: [{ witness: witnessHex }],
    });
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBe('text/html');
    const onChainBody = parsed[0].getDataRaw();
    expect(onChainBody.length).toBe(compressed.length);
    for (let i = 0; i < compressed.length; i++) {
      expect(onChainBody[i]).toBe(compressed[i]);
    }

    // Phase 5: the witness must also carry the `content_encoding: gzip`
    // envelope tag. Tag 0x09 encodes as OP_9 (0x59); the value is a
    // 4-byte push (OP_PUSHBYTES_4 = 0x04) of UTF-8 'gzip'
    // (0x67 0x7a 0x69 0x70).
    const allWitnessHex = witnessHex.join('');
    expect(allWitnessHex).toContain('5904' + '677a6970');

    // Phase 6: decompress the on-chain bytes — equal to the original
    // body. Proves the gzip envelope tag is honoured by any consumer
    // that does its own decompression (here node:zlib, independent of
    // the Compression Streams API the SDK used to compress).
    const decompressed = gunzipSync(onChainBody);
    expect(decompressed).toEqual(Buffer.from(original));

    // Phase 6b: ordpool-parser recovers the ORIGINAL bytes itself. The
    // parser reads content_encoding: 'gzip' and auto-decompresses on
    // getContent() / getDataUri() (getDataRaw stays the raw compressed
    // bytes, asserted in phase 4). This is the end-user render path: an
    // explorer shows the decompressed HTML, not the gzip blob.
    const recovered = await parsed[0].getContent();
    expect(recovered).toBe(new TextDecoder().decode(original));
    expect(parsed[0].getContentEncoding()).toBe('gzip');

    // Phase 7: cat21-ord saw two cats on this inscription too — the
    // nLockTime=21-on-both-txs behaviour applies whatever the body
    // content. Confirm both at the recipient's UTXO.
    await waitForOrdSync(revealTip);
    const catA = await waitForCatAtAddress(catInscriptionId(commitTxid), recipientAddress, 30_000);
    const catB = await waitForCatAtAddress(catInscriptionId(revealTxid), recipientAddress, 30_000);
    // Both cats live at the SAME satpoint: the first sat (offset 0)
    // of the reveal's vout[0]. ord's `/inscription/<id>` JSON exposes
    // this as `satpoint = <txid>:<vout>:<offset>`.
    const expectedSatpoint = `${revealTxid}:0:0`;
    expect(catA.satpoint).toBe(expectedSatpoint);
    expect(catB.satpoint).toBe(expectedSatpoint);
  }, 240_000);
});
