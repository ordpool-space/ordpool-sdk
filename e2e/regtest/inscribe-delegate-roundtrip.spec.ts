/**
 * Inscribe → delegate + metadata roundtrip on regtest, verified by a
 * real upstream-style ord daemon.
 *
 * Unlike `parent` (annotation only, no tx-topology link), a `delegate`
 * is FUNCTIONAL: an inscription with a delegate carries an empty body
 * and ord serves the delegate target's content in its place. This spec
 * proves the SDK's first-class `delegate` arg produces an inscription
 * that a real ord resolves — the strongest possible proof, since it
 * exercises ord's own delegate-resolution path, not just our parser.
 *
 * Flow:
 *   1. Inscribe A — a normal text inscription (the delegate TARGET).
 *   2. Inscribe B — empty body, `delegate: A_id` (the DELEGATE).
 *   3. Broadcast + confirm both commit/reveal pairs.
 *   4. Parser proof: B's reveal witness decodes to `getDelegates() ===
 *      [A_id]` with a zero-length body.
 *   5. ord proof: `GET /content/<B_id>` on stock ord returns A's body
 *      bytes — ord resolved the delegate.
 *
 * A second test inscribes CBOR metadata and proves the on-chain bytes
 * round-trip through ordpool-parser's `getMetadata()`.
 *
 * Requires the `ord-stock` compose profile:
 *   docker compose -f e2e/docker-compose.regtest.yml \
 *     --profile ord-stock up -d
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { InscriptionParserService } from 'ordpool-parser';

import { encodeCborDeterministic } from '../../src/inscribe/inscription-cbor';
import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  EsploraTx,
  inscriptionId,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForOrdStockInscription,
  getStockOrdContent,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC
const FEE_RATE = 5;

const PSBT_WALLET = 'ordpool-e2e';
function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

describe('inscribe → delegate + metadata roundtrip on regtest (stock ord)', () => {

  const scureRegtest = toScureNetwork(Network.Regtest);

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
  }, 90_000);

  /**
   * Fund a fresh SegWit input, build the inscribe pair for `extra`
   * (the per-inscription content fields: body, contentType, delegate,
   * metadata, …), sign + broadcast the commit, then broadcast the
   * reveal. Returns the confirmed reveal tx + its inscription id.
   */
  async function inscribeAndConfirm(
    extra: Record<string, unknown>,
  ): Promise<{ revealTxid: string; revealTx: EsploraTx; revealTip: number; id: string }> {
    const recipientKey = secp256k1.utils.randomPrivateKey();
    const recipientAddress = btc.p2tr(schnorr.getPublicKey(recipientKey), undefined, scureRegtest, true).address!;

    const fundingPaymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingPaymentAddress));
    const fundingPaymentPublicKey = hex.decode(addrInfo.pubkey);

    bitcoinCliPsbtWallet('sendtoaddress', fundingPaymentAddress, '1.0');
    await waitForElectrsSync(mineBlocks(1));
    const utxo = await waitForUtxoAt(fundingPaymentAddress, FUND_AMOUNT_SATS);

    const inscribed = createInscribeTransactions({
      paymentOutput: { txid: utxo.txid, vout: utxo.vout, value: utxo.value, status: { confirmed: true } },
      paymentPublicKey: fundingPaymentPublicKey,
      paymentAddress: fundingPaymentAddress,
      recipientAddress,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
      ...(extra as object),
    } as Parameters<typeof createInscribeTransactions>[0]);

    // Sign + broadcast the commit via bitcoin-cli.
    const unsignedCommitBase64 = base64.encode(inscribed.commitPsbt);
    const walletprocessed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt', `psbt=${unsignedCommitBase64}`, 'sign=true', 'finalize=true',
    ));
    expect(walletprocessed.complete).toBe(true);
    // BC's `hex` is the authoritative wire-tx; a scure fromPSBT round-trip
    // corrupts the witness on commit outputs with an envelope tap leaf.
    const signedCommit = btc.Transaction.fromRaw(hex.decode(walletprocessed.hex));
    const commitTxid = await postTx(signedCommit.hex);
    expect(commitTxid).toBe(inscribed.commitTxid);
    mineBlocks(1);
    await waitForTxConfirmed(commitTxid);

    const revealTxid = await postTx(inscribed.revealHex);
    expect(revealTxid).toBe(inscribed.revealTxid);
    const revealTip = mineBlocks(1);
    await waitForElectrsSync(revealTip);
    const revealTx: EsploraTx = await waitForTxConfirmed(revealTxid);

    return { revealTxid, revealTx, revealTip, id: inscriptionId(revealTxid, 0) };
  }

  it('a delegate inscription (empty body) is resolved by stock ord to its target content', async () => {
    // Phase 1: inscribe A, the delegate TARGET.
    const targetText = `delegate target @ ${new Date().toISOString()}`;
    const targetBody = new TextEncoder().encode(targetText);
    const a = await inscribeAndConfirm({
      body: targetBody,
      contentType: 'text/plain;charset=utf-8',
    });

    // Phase 2: inscribe B, empty body, delegate → A. No contentType:
    // a delegate serves the target's content-type too.
    const b = await inscribeAndConfirm({
      body: new Uint8Array(0),
      delegate: a.id,
    });

    // Phase 3: parser proof — B's reveal witness carries the delegate
    // tag and an empty body.
    const bWitness = (b.revealTx as unknown as { vin: { witness: string[] }[] }).vin[0].witness;
    const parsedB = InscriptionParserService.parse({ txid: b.revealTxid, vin: [{ witness: bWitness }] });
    expect(parsedB.length).toBe(1);
    expect(parsedB[0].getDelegates()).toEqual([a.id]);
    expect(parsedB[0].getDataRaw().length).toBe(0);

    // Phase 4: ord proof — stock ord resolves B's content to A's bytes.
    await waitForOrdStockSync(b.revealTip);
    const insc = await waitForOrdStockInscription(b.id);
    expect(insc.id).toBe(b.id);
    const content = await getStockOrdContent(b.id);
    // ord served A's body when asked for B's content — the delegate
    // resolved end-to-end.
    expect(content.bytes.length).toBe(targetBody.length);
    for (let i = 0; i < targetBody.length; i++) {
      expect(content.bytes[i]).toBe(targetBody[i]);
    }
    expect(new TextDecoder().decode(content.bytes)).toBe(targetText);
  }, 300_000);

  it('CBOR metadata round-trips on chain: parser surfaces the same object from the reveal witness', async () => {
    const metadataValue = {
      name: 'Ordpool Genesis',
      attributes: { rarity: 'legendary', power: 9000 },
      minted_by: 'ordpool.space',
    };
    const metadata = encodeCborDeterministic(metadataValue);

    const inscribed = await inscribeAndConfirm({
      body: new TextEncoder().encode('inscription with metadata'),
      contentType: 'text/plain;charset=utf-8',
      metadata,
    });

    const witness = (inscribed.revealTx as unknown as { vin: { witness: string[] }[] }).vin[0].witness;
    const parsed = InscriptionParserService.parse({ txid: inscribed.revealTxid, vin: [{ witness }] });
    expect(parsed.length).toBe(1);
    expect(parsed[0].getMetadata()).toEqual(metadataValue);
  }, 240_000);
});
