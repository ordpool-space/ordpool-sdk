/**
 * Byte-parity with the REFERENCE ord client.
 *
 * We build an inscription envelope with the SDK, build the SAME inscription
 * with `ord wallet inscribe` (ord's own code — `append_reveal_script`,
 * identical to stock ord), and assert the envelopes are BYTE-IDENTICAL.
 * Then we broadcast an SDK inscription and assert stock ord indexes it
 * BLESSED — the same class as ord's own inscriptions, not cursed/vindicated.
 *
 * This is the guarantee that the SDK's envelope encoding matches ord
 * exactly (the tag data-push form, `01 0N`, not the `OP_N` pushnum that
 * ord curses). Requires the cat21-ord + ord-stock profiles.
 */
import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { buildInscriptionEnvelope, ORD_TAGS, type OrdEnvelopeField } from '../../src/inscribe/inscription-envelope';
import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  inscriptionId,
  mineBlocks,
  ordCreateWallet,
  ordWalletInscribe,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdStockInscription,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
  writeCat21OrdFile,
} from './regtest-helpers';

const scureRegtest = toScureNetwork(Network.Regtest);
const ORD_WALLET = 'ordparity';
const PSBT_WALLET = 'ordpool-e2e';
const TXT_CONTENT_TYPE = 'text/plain;charset=utf-8'; // ord's inferred type for a .txt file

function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

/**
 * The envelope ord actually put in the reveal witness, minus the
 * `<pubkey(32)> OP_CHECKSIG` prefix (34 bytes = 68 hex chars) — that prefix
 * differs only by the reveal key, which is irrelevant to the encoding.
 */
function ordEnvelopePostPubkey(revealTxid: string): string {
  const revealHex = rpc('getrawtransaction', revealTxid);
  const tx = btc.Transaction.fromRaw(hex.decode(revealHex));
  const envelope = tx.getInput(0).finalScriptWitness![1];
  return hex.encode(envelope).slice(68);
}

function sdkEnvelopePostPubkey(
  contentType: string,
  body: Uint8Array,
  fields: OrdEnvelopeField[] = [],
): string {
  const env = buildInscriptionEnvelope({
    revealPubkeyXonly: new Uint8Array(32).fill(7),
    contentType,
    body,
    fields,
  });
  return hex.encode(env).slice(68);
}

describe('inscribe → byte-parity + blessing-parity with stock ord', () => {

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await waitForOrdReady(60_000);
    // Fund ord's OWN wallet so its `wallet inscribe` has a UTXO to spend.
    // Mining 101 to it also puts the tip well past the regtest jubilee
    // (110), so the blessing test reflects mainnet (always post-jubilee).
    const ordAddr = ordCreateWallet(ORD_WALLET);
    rpc('generatetoaddress', '101', ordAddr);
    const tip = Number(rpc('getblockcount'));
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);
  }, 180_000);

  it('SDK envelope is byte-identical to `ord wallet inscribe` (plain text)', async () => {
    const body = new TextEncoder().encode('parity: plain text body');
    writeCat21OrdFile('/tmp/parity-plain.txt', body);
    const { reveal } = ordWalletInscribe(ORD_WALLET, '/tmp/parity-plain.txt', 5);
    await waitForOrdSync(mineBlocks(1));

    expect(sdkEnvelopePostPubkey(TXT_CONTENT_TYPE, body)).toBe(ordEnvelopePostPubkey(reveal));
  }, 120_000);

  it('SDK envelope is byte-identical to ord WITH a metaprotocol tag (multi-tag order + encoding)', async () => {
    const body = new TextEncoder().encode('parity: with metaprotocol');
    writeCat21OrdFile('/tmp/parity-meta.txt', body);
    const { reveal } = ordWalletInscribe(ORD_WALLET, '/tmp/parity-meta.txt', 5, ['--metaprotocol', 'brc-20']);
    await waitForOrdSync(mineBlocks(1));

    const sdk = sdkEnvelopePostPubkey(TXT_CONTENT_TYPE, body, [
      { tag: ORD_TAGS.metaprotocol, value: new TextEncoder().encode('brc-20') },
    ]);
    expect(sdk).toBe(ordEnvelopePostPubkey(reveal));
  }, 120_000);

  it('an SDK-built inscription is BLESSED by stock ord (not cursed/vindicated)', async () => {
    const recipientKey = secp256k1.utils.randomPrivateKey();
    const recipientAddress = btc.p2tr(schnorr.getPublicKey(recipientKey), undefined, scureRegtest, true).address!;

    const fundingAddr = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const fundingPubkey = hex.decode(JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingAddr)).pubkey);
    bitcoinCliPsbtWallet('sendtoaddress', fundingAddr, '1.0');
    await waitForElectrsSync(mineBlocks(1));
    const utxo = await waitForUtxoAt(fundingAddr, 100_000_000);

    const body = new TextEncoder().encode('blessed, same as ord');
    const inscribed = createInscribeTransactions({
      paymentOutput: { txid: utxo.txid, vout: utxo.vout, value: utxo.value, status: { confirmed: true } },
      paymentPublicKey: fundingPubkey,
      paymentAddress: fundingAddr,
      recipientAddress,
      body,
      contentType: TXT_CONTENT_TYPE,
      feeRatePerVbyte: 5,
      network: Network.Regtest,
    });

    const processed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt', `psbt=${base64.encode(inscribed.commitPsbt)}`, 'sign=true', 'finalize=true',
    ));
    expect(processed.complete).toBe(true);
    const commitTxid = await postTx(btc.Transaction.fromRaw(hex.decode(processed.hex)).hex);
    mineBlocks(1);
    await waitForTxConfirmed(commitTxid);

    const revealTxid = await postTx(inscribed.revealHex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(revealTxid);
    await waitForOrdStockSync(tip);

    const insc = await waitForOrdStockInscription(inscriptionId(revealTxid, 0));
    // Blessed: non-negative number AND no curse charm — exactly how ord's
    // own single-input inscriptions index. (The default data-push tag form
    // carries no `Curse::Pushnum`.)
    expect(insc.number).toBeGreaterThanOrEqual(0);
    expect(insc.charms ?? []).not.toContain('cursed');
    expect(insc.charms ?? []).not.toContain('vindicated');
  }, 180_000);

  it('minimalTagPush:true makes stock ord stamp the `vindicated` charm', async () => {
    // Same inscription, only `minimalTagPush: true`. The pushnum tag form
    // trips ord's `Curse::Pushnum`; post-jubilee (the beforeAll mined past
    // 110) that resolves to a `vindicated` charm with a non-negative number.
    // This pins the flag's real-ord effect — the ONLY thing it changes.
    const recipientKey = secp256k1.utils.randomPrivateKey();
    const recipientAddress = btc.p2tr(schnorr.getPublicKey(recipientKey), undefined, scureRegtest, true).address!;

    const fundingAddr = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const fundingPubkey = hex.decode(JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingAddr)).pubkey);
    bitcoinCliPsbtWallet('sendtoaddress', fundingAddr, '1.0');
    await waitForElectrsSync(mineBlocks(1));
    const utxo = await waitForUtxoAt(fundingAddr, 100_000_000);

    const body = new TextEncoder().encode('vindicated by pushnum');
    const inscribed = createInscribeTransactions({
      paymentOutput: { txid: utxo.txid, vout: utxo.vout, value: utxo.value, status: { confirmed: true } },
      paymentPublicKey: fundingPubkey,
      paymentAddress: fundingAddr,
      recipientAddress,
      body,
      contentType: TXT_CONTENT_TYPE,
      feeRatePerVbyte: 5,
      minimalTagPush: true,
      network: Network.Regtest,
    });

    const processed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt', `psbt=${base64.encode(inscribed.commitPsbt)}`, 'sign=true', 'finalize=true',
    ));
    expect(processed.complete).toBe(true);
    const commitTxid = await postTx(btc.Transaction.fromRaw(hex.decode(processed.hex)).hex);
    mineBlocks(1);
    await waitForTxConfirmed(commitTxid);

    const revealTxid = await postTx(inscribed.revealHex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(revealTxid);
    await waitForOrdStockSync(tip);

    const insc = await waitForOrdStockInscription(inscriptionId(revealTxid, 0));
    // Post-jubilee: vindicated (NOT cursed), number still non-negative.
    // The body + content-type are unchanged from the blessed case — only
    // the charm differs, which is the whole point of the flag.
    expect(insc.charms ?? []).toContain('vindicated');
    expect(insc.charms ?? []).not.toContain('cursed');
    expect(insc.number).toBeGreaterThanOrEqual(0);
  }, 180_000);
});
