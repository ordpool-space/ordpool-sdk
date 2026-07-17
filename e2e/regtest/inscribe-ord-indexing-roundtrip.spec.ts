/**
 * Inscribe → real-ord-indexing roundtrip on regtest.
 *
 * Proves the inscriptions the SDK builds (commit + reveal via
 * `createInscribeTransactions`) are recognised + indexed by a real
 * upstream-style ord daemon. The sibling `inscribe-redirect-roundtrip`
 * spec already proves the bytes parse via `ordpool-parser`; this spec
 * closes the gap on the OTHER consumer ord-protocol inscriptions
 * ultimately surface through.
 *
 * Flow:
 *   1. Random keys for the recipient. Fund a SegWit input from the
 *      regtest wallet (same wallet-less pattern as the redirect spec).
 *   2. `createInscribeTransactions(...)` builds commit + reveal.
 *   3. Sign + broadcast commit. Mine 1 block.
 *   4. Broadcast reveal. Mine 1 block.
 *   5. Wait for stock ord to sync past the reveal height.
 *   6. `GET /inscription/<revealTxid>i0` — ord must answer 200 with
 *      `address === recipient`, `content_type` and `content_length`
 *      matching what we inscribed.
 *   7. `GET /content/<id>` — body bytes match what we inscribed,
 *      byte-for-byte.
 *
 * Requires the `ord-stock` compose profile to be up:
 *     docker compose -f e2e/docker-compose.regtest.yml \
 *       --profile ord-stock up -d
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  ElectrsUtxo,
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
const INSCRIPTION_BODY_TEXT = 'hello from createInscribeTransactions';
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

const PSBT_WALLET = 'ordpool-e2e';
function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

describe('inscribe → real-ord indexing roundtrip on regtest', () => {

  const scureRegtest = toScureNetwork(Network.Regtest);

  let recipientAddress: string;
  let fundingPaymentAddress: string;
  let fundingPaymentPublicKey: Uint8Array;
  let utxo: ElectrsUtxo;

  beforeAll(async () => {
    // Bail early with a useful message if the `ord-stock` profile isn't
    // running — the rest of the spec is wasted setup otherwise.
    await waitForOrdStockReady(60_000);

    const recipientKey = secp256k1.utils.randomPrivateKey();
    recipientAddress = btc.p2tr(schnorr.getPublicKey(recipientKey), undefined, scureRegtest, true).address!;

    fundingPaymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingPaymentAddress));
    fundingPaymentPublicKey = hex.decode(addrInfo.pubkey);

    bitcoinCliPsbtWallet('sendtoaddress', fundingPaymentAddress, '1.0');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    utxo = await waitForUtxoAt(fundingPaymentAddress, FUND_AMOUNT_SATS);
  }, 90_000);

  it('SDK-built inscription is indexed by stock ord with matching content + recipient', async () => {
    // Phase 1: SDK build.
    const body = new TextEncoder().encode(INSCRIPTION_BODY_TEXT);
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
      network: Network.Regtest,
    });

    // Phase 2: sign + broadcast the commit via bitcoin-cli.
    const unsignedCommitBase64 = base64.encode(inscribed.commitPsbt);
    const walletprocessed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt',
      `psbt=${unsignedCommitBase64}`,
      'sign=true',
      'finalize=true',
    ));
    expect(walletprocessed.complete).toBe(true);
    // BC's `hex` field is the authoritative wire-tx; a scure
    // fromPSBT + tx.hex round-trip on a BC-finalized PSBT corrupts
    // the witness on commit outputs with an envelope tap leaf.
    const signedCommit = btc.Transaction.fromRaw(hex.decode(walletprocessed.hex));
    const commitTxid = await postTx(signedCommit.hex);
    expect(commitTxid).toBe(inscribed.commitTxid);

    // waitForElectrsSync + getTxStatus is racy (block header ingested
    // before per-tx status catches up). waitForTxConfirmed polls
    // per-tx directly.
    mineBlocks(1);
    await waitForTxConfirmed(commitTxid);

    // Phase 3: broadcast the reveal + confirm.
    const revealTxid = await postTx(inscribed.revealHex);
    expect(revealTxid).toBe(inscribed.revealTxid);
    const revealTip = mineBlocks(1);
    await waitForElectrsSync(revealTip);
    const revealTx = await waitForTxConfirmed(revealTxid);
    expect(revealTx.status.block_hash).toBeTruthy();

    // Phase 4: wait for stock ord to catch up + index. ord lags
    // bitcoind by a few hundred ms, so the inscription lookup races
    // the indexer without this gate.
    await waitForOrdStockSync(revealTip);
    const id = inscriptionId(revealTxid, 0);
    const insc = await waitForOrdStockInscription(id);

    // Phase 5: assertions on ord's view of the inscription.
    expect(insc.id).toBe(id);
    expect(insc.address).toBe(recipientAddress);
    expect(insc.content_type).toBe(INSCRIPTION_CONTENT_TYPE);
    expect(insc.content_length).toBe(body.length);
    // The reveal output we built is the postage output — 546 sats per
    // CAT-21 convention; the inscribe orchestrator uses the same floor.
    expect(insc.value).toBeGreaterThan(0);

    // Phase 6: byte-equal content roundtrip via ord's /content/<id>.
    const content = await getStockOrdContent(id);
    expect(content.bytes.length).toBe(body.length);
    for (let i = 0; i < body.length; i++) {
      expect(content.bytes[i]).toBe(body[i]);
    }
    // ord normalises content-type to lower-case and may drop charset
    // formatting, so match against the prefix instead of an exact
    // string compare.
    expect(content.contentType?.toLowerCase().startsWith('text/plain')).toBe(true);
  }, 180_000);
});
