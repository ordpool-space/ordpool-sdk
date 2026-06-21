/**
 * Inscribe → real-ord-indexing roundtrip on regtest, parametrised
 * over multiple tip amounts.
 *
 * Proves the SDK's optional reveal-tx tip output:
 *   - lands at vout[1] of the reveal (not vout[0] — ord's
 *     first-sat-of-first-output rule pins the inscription there);
 *   - holds exactly `tip.value` sats on a fresh tip address;
 *   - is fed by enough sats in the commit output (postage + reveal
 *     fee + tip) so the reveal balances at the requested fee rate;
 *   - doesn't perturb ord's view of the inscription (content,
 *     content-type, address, content-length all match).
 *
 * Test matrix:
 *   - no tip                (baseline — confirms no regression)
 *   - 546-sat tip           (dust floor)
 *   - 5 000-sat tip         (typical "nice tip" value)
 *   - 21 000-sat tip        (heftier — covers any rounding edge)
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
import { INSCRIBE_POSTAGE_SATS } from '../../src/inscribe/inscription-commit.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  ElectrsUtxo,
  EsploraTx,
  getTxStatus,
  getUtxos,
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
} from './regtest-helpers';

const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC
const FEE_RATE = 5;
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

const PSBT_WALLET = 'ordpool-e2e';
function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

interface TipCase {
  label: string;
  tipSats: number | undefined; // undefined = no tip output
}

const TIP_CASES: TipCase[] = [
  { label: 'no tip',           tipSats: undefined },
  { label: '546-sat dust tip', tipSats: 546 },
  { label: '5 000-sat tip',    tipSats: 5_000 },
  { label: '21 000-sat tip',   tipSats: 21_000 },
];

describe('inscribe → tip output → ord-indexing roundtrip on regtest', () => {

  const scureRegtest = toScureNetwork(Network.Regtest);

  beforeAll(async () => {
    // Bail early with a useful message if the `ord-stock` profile isn't
    // running — the rest of the spec is wasted setup otherwise.
    await waitForOrdStockReady(60_000);
  }, 90_000);

  it.each(TIP_CASES)('mint with $label produces a valid tx, lands at ord with content roundtrip', async ({ label, tipSats }) => {
    // Fresh keys per case so the tip + recipient addresses don't
    // collide across iterations.
    const recipientKey = secp256k1.utils.randomPrivateKey();
    const recipientAddress = btc.p2tr(schnorr.getPublicKey(recipientKey), undefined, scureRegtest, true).address!;

    let tipAddress: string | undefined;
    let tip: { address: string; value: number } | undefined;
    if (tipSats !== undefined) {
      const tipKey = secp256k1.utils.randomPrivateKey();
      tipAddress = btc.p2tr(schnorr.getPublicKey(tipKey), undefined, scureRegtest, true).address!;
      expect(tipAddress).not.toBe(recipientAddress);
      tip = { address: tipAddress, value: tipSats };
    }

    const fundingPaymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingPaymentAddress));
    const fundingPaymentPublicKey = hex.decode(addrInfo.pubkey);

    bitcoinCliPsbtWallet('sendtoaddress', fundingPaymentAddress, '1.0');
    await waitForElectrsSync(mineBlocks(1));
    const utxos = await getUtxos(fundingPaymentAddress);
    const utxo: ElectrsUtxo | undefined = utxos.find(u => u.value === FUND_AMOUNT_SATS);
    if (!utxo) throw new Error(`Funding UTXO not found at ${fundingPaymentAddress}`);

    // Per-case body so the inscription content is unique across runs
    // and ord-side caching can't mask a regression.
    const bodyText = `tip-roundtrip: ${label} @ ${new Date().toISOString()}`;
    const body = new TextEncoder().encode(bodyText);

    // Phase 1: SDK build with tip.
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
      tip,
      network: Network.Regtest,
    });

    // Sanity: the commit output's sats should equal postage +
    // revealFee + tip — that's the SDK's bookkeeping contract.
    const expectedCommitOutputSats =
      INSCRIBE_POSTAGE_SATS + inscribed.fees.revealFeeSats + (tipSats ?? 0);
    expect(inscribed.commit.outputValueSats).toBe(expectedCommitOutputSats);

    // Phase 2: sign + broadcast the commit.
    const unsignedCommitBase64 = base64.encode(inscribed.commitPsbt);
    const walletprocessed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt',
      `psbt=${unsignedCommitBase64}`,
      'sign=true',
      'finalize=true',
    ));
    expect(walletprocessed.complete).toBe(true);
    const signedCommit = btc.Transaction.fromPSBT(base64.decode(walletprocessed.psbt));
    if (!signedCommit.isFinal) signedCommit.finalize();
    const commitTxid = await postTx(signedCommit.hex);
    expect(commitTxid).toBe(inscribed.commitTxid);

    const commitTip = mineBlocks(1);
    await waitForElectrsSync(commitTip);
    const commitStatus = await getTxStatus(commitTxid);
    expect(commitStatus.confirmed).toBe(true);

    // Phase 3: broadcast the reveal + confirm.
    const revealTxid = await postTx(inscribed.revealHex);
    expect(revealTxid).toBe(inscribed.revealTxid);
    const revealTip = mineBlocks(1);
    await waitForElectrsSync(revealTip);
    const revealTx: EsploraTx = await waitForTxConfirmed(revealTxid);
    expect(revealTx.status.block_hash).toBeTruthy();

    // Phase 4: assertions on the reveal tx shape.
    const revealVout = revealTx.vout as Array<{ value: number; scriptpubkey_address: string }>;
    if (tipSats === undefined) {
      expect(revealVout.length).toBe(1);
      expect(revealVout[0].value).toBe(INSCRIBE_POSTAGE_SATS);
      expect(revealVout[0].scriptpubkey_address).toBe(recipientAddress);
    } else {
      expect(revealVout.length).toBe(2);
      expect(revealVout[0].value).toBe(INSCRIBE_POSTAGE_SATS);
      expect(revealVout[0].scriptpubkey_address).toBe(recipientAddress);
      expect(revealVout[1].value).toBe(tipSats);
      expect(revealVout[1].scriptpubkey_address).toBe(tipAddress);
    }

    // Phase 5: wait for stock ord to sync + verify it indexes the
    // inscription correctly, REGARDLESS of the tip output.
    await waitForOrdStockSync(revealTip);
    const id = inscriptionId(revealTxid, 0);
    const insc = await waitForOrdStockInscription(id);
    expect(insc.id).toBe(id);
    expect(insc.address).toBe(recipientAddress);
    expect(insc.content_type).toBe(INSCRIPTION_CONTENT_TYPE);
    expect(insc.content_length).toBe(body.length);
    expect(insc.value).toBe(INSCRIBE_POSTAGE_SATS);

    // Phase 6: byte-equal content roundtrip via ord's /content/<id>.
    const content = await getStockOrdContent(id);
    expect(content.bytes.length).toBe(body.length);
    for (let i = 0; i < body.length; i++) {
      expect(content.bytes[i]).toBe(body[i]);
    }
    expect(content.contentType?.toLowerCase().startsWith('text/plain')).toBe(true);
  }, 240_000);
});
