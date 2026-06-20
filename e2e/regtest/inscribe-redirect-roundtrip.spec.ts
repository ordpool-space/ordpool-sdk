/**
 * Bearer-key flexibility roundtrip on regtest.
 *
 * The orchestrator returns the ephemeral private key as a bearer
 * instrument: anyone holding it can spend the commit output via the
 * envelope leaf, producing ANY reveal-tx shape they want. This spec
 * proves that flexibility by:
 *
 *   1. Building a commit + default reveal (recipient = address A)
 *      via the orchestrator. Discard the default reveal.
 *   2. Broadcasting the commit and mining it.
 *   3. Using the ephemeral key + envelope metadata returned by the
 *      orchestrator to construct an ENTIRELY NEW reveal whose
 *      recipient is address B (not A). This is the "redirect"
 *      use case the maintainer flagged: change the destination
 *      after commit but before reveal.
 *   4. Broadcasting the redirected reveal and confirming the
 *      inscription lands at B, with content roundtrip verified
 *      via ordpool-parser.
 *
 * The same code path covers the other bearer-key use cases:
 *
 *   - **Recover-to-self**: pass `recipientAddress = userAddress`
 *     instead of B. The "reveal" lands the postage back at the
 *     user. (No script-path-only "recovery leaf" needed.)
 *   - **RBF**: build a fresh reveal at a higher fee rate, broadcast
 *     (same input → same outpoint → BIP-125 replacement).
 *   - **Delay**: sit on the ephemeral key, build the reveal later.
 *
 * This is byte-equivalent to ord's design — see
 * `src/wallet/batch/plan.rs:367-382` for the ephemeral-key-as-
 * internal-key shape, lines 676-709 for ord's persistence
 * (it imports the key into Bitcoin Core's wallet under the label
 * `commit tx recovery key`).
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { InscriptionParserService } from 'ordpool-parser';

import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import {
  buildInscribeRevealTx,
} from '../../src/inscribe/inscription-reveal.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  ElectrsUtxo,
  getTx,
  getTxStatus,
  getUtxos,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForTxConfirmed,
} from './regtest-helpers';

const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC
const FEE_RATE = 5;
const INSCRIPTION_BODY_TEXT = 'redirected inscription via ephemeral bearer key';
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

const PSBT_WALLET = 'ordpool-e2e';
function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

describe('inscribe redirect-via-ephemeral-key roundtrip on regtest', () => {

  const scureRegtest = toScureNetwork(Network.Regtest);

  let originalRecipientAddress: string;
  let redirectRecipientAddress: string;
  let fundingPaymentAddress: string;
  let fundingPaymentPublicKey: Uint8Array;
  let utxo: ElectrsUtxo;

  beforeAll(async () => {
    // Two distinct recipients: the address we tell the orchestrator
    // to send to, and the address we ACTUALLY send to after we get
    // back the ephemeral key. The point of the spec is that those
    // can differ.
    const aKey = secp256k1.utils.randomPrivateKey();
    const bKey = secp256k1.utils.randomPrivateKey();
    originalRecipientAddress = btc.p2tr(schnorr.getPublicKey(aKey), undefined, scureRegtest, true).address!;
    redirectRecipientAddress = btc.p2tr(schnorr.getPublicKey(bKey), undefined, scureRegtest, true).address!;
    expect(originalRecipientAddress).not.toBe(redirectRecipientAddress);

    fundingPaymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingPaymentAddress));
    fundingPaymentPublicKey = hex.decode(addrInfo.pubkey);

    bitcoinCliPsbtWallet('sendtoaddress', fundingPaymentAddress, '1.0');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);

    const utxos = await getUtxos(fundingPaymentAddress);
    const found = utxos.find(u => u.value === FUND_AMOUNT_SATS);
    if (!found) throw new Error(`Funding UTXO not found at ${fundingPaymentAddress}`);
    utxo = found;
  });

  it('builds commit → broadcasts → uses ephemeral key to redirect reveal to a NEW recipient → confirms on chain', async () => {
    // Phase 1: SDK build. The orchestrator's default reveal points
    // at `originalRecipientAddress` (A). We're going to discard it
    // and build a NEW reveal pointing at B with the ephemeral key.
    const inscribed = createInscribeTransactions({
      paymentOutput: {
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        status: { confirmed: true },
      },
      paymentPublicKey: fundingPaymentPublicKey,
      paymentAddress: fundingPaymentAddress,
      recipientAddress: originalRecipientAddress,
      body: new TextEncoder().encode(INSCRIPTION_BODY_TEXT),
      contentType: INSCRIPTION_CONTENT_TYPE,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });

    expect(inscribed.ephemeral.privKey.length).toBe(32);
    expect(inscribed.ephemeral.pubkeyXonly.length).toBe(32);

    // Phase 2: sign + broadcast the commit via bitcoin-cli.
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

    // Phase 3: rebuild the reveal targeting B instead of A. We
    // construct the taptree the same way the commit helper did
    // (single envelope leaf, ephemeral pubkey as internal key) so
    // the leaf's control block matches what the on-chain commit
    // committed to.
    const envelopeLeaf = { script: inscribed.commit.envelopeScript };
    const replayP2tr = btc.p2tr(
      inscribed.ephemeral.pubkeyXonly,
      [envelopeLeaf],
      scureRegtest,
      true,
    );
    if (replayP2tr.tapLeafScript === undefined) {
      throw new Error('replay taptree returned no tapLeafScript');
    }
    // Sanity: the reconstructed commit script matches what's on chain.
    expect(replayP2tr.script).toEqual(inscribed.commit.outputScript);

    const redirected = buildInscribeRevealTx({
      commitTxid,
      commitVout: 0,
      commitOutputValueSats: inscribed.commit.outputValueSats,
      commitOutputScript: inscribed.commit.outputScript,
      taproot: {
        internalKey: replayP2tr.tapInternalKey,
        tapLeafScript: replayP2tr.tapLeafScript,
      },
      ephemeralPrivKey: inscribed.ephemeral.privKey,
      recipientAddress: redirectRecipientAddress,
      network: Network.Regtest,
    });

    // The redirected reveal MUST be different from the default reveal
    // (different recipient → different output → different txid).
    expect(redirected.revealTxid).not.toBe(inscribed.revealTxid);

    // Phase 4: broadcast the redirected reveal + confirm.
    const revealTxid = await postTx(redirected.revealHex);
    expect(revealTxid).toBe(redirected.revealTxid);
    await waitForElectrsSync(mineBlocks(1));
    const revealTx = await waitForTxConfirmed(revealTxid);
    expect(revealTx.status.block_hash).toBeTruthy();

    // Phase 5: confirm the inscription landed at B (not A).
    const recipientUtxos = await getUtxos(redirectRecipientAddress);
    expect(recipientUtxos.find(u => u.txid === revealTxid)).toBeDefined();

    const aUtxos = await getUtxos(originalRecipientAddress);
    expect(aUtxos.find(u => u.txid === revealTxid)).toBeUndefined();

    // Phase 6: content roundtrip via ordpool-parser proves the
    // envelope script (and therefore the inscription) is preserved
    // byte-for-byte through the redirect.
    const witnessHex = (revealTx as unknown as { vin: { witness: string[] }[] }).vin[0].witness;
    const parsed = InscriptionParserService.parse({
      txid: revealTxid,
      vin: [{ witness: witnessHex }],
    });
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBe(INSCRIPTION_CONTENT_TYPE);
    const recovered = new TextDecoder().decode(parsed[0].getDataRaw());
    expect(recovered).toBe(INSCRIPTION_BODY_TEXT);
  });
});
