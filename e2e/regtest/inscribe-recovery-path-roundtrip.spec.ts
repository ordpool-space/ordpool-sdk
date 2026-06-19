/**
 * Recovery-path inscribe roundtrip on regtest.
 *
 * The inscribe commit output is a P2TR with a 2-leaf taptree:
 *
 *   Leaf 0 — envelope (`<ephemeralPubkey> CHECKSIG OP_FALSE OP_IF
 *           "ord" <tags> OP_0 <body chunks> OP_ENDIF`). The reveal
 *           tx spends via this leaf.
 *   Leaf 1 — recovery (`<userPubkeyXonly> OP_CHECKSIG`). Lets the
 *           user reclaim the postage when the reveal never lands
 *           (broadcast failure, content-policy block, lost
 *           ephemeral key, etc.).
 *
 * Phase 1 of the inscribe pipeline (per OSS-INSCRIBERS.md) has no
 * journal and no retry — once `createInscribeTransactions` returns,
 * the ephemeral key is zeroed and the reveal can't be re-signed. So
 * the leaf-1 path is the ONLY way to recover stuck commit value
 * without abandoning the funds.
 *
 * This spec proves end-to-end that the recovery path works: build
 * a commit, broadcast it, mine, then spend the commit output via
 * `buildInscribeRecoveryTx` (Schnorr-signs the recovery leaf with
 * the user's key), and confirm the postage lands at the recovery
 * address.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import {
  buildInscribeRecoveryTx,
  createInscribeTransactions,
} from '../../src/inscribe/inscription.service.helper';
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

const PSBT_WALLET = 'ordpool-e2e';
function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

describe('inscribe recovery path roundtrip on regtest', () => {

  const scureRegtest = toScureNetwork(Network.Regtest);

  let userPrivKey: Uint8Array;
  let userPubkeyXonly: Uint8Array;
  let recoveryAddress: string;
  let fundingPaymentAddress: string;
  let fundingPaymentPublicKey: Uint8Array;
  let utxo: ElectrsUtxo;

  beforeAll(async () => {
    // The "user's recovery key" — generated once per test, then used
    // as both the inscribe `paymentPubkeyXonly` (which goes into the
    // recovery leaf) AND the Schnorr signer for the recovery tx.
    userPrivKey = secp256k1.utils.randomPrivateKey();
    userPubkeyXonly = schnorr.getPublicKey(userPrivKey);
    const userP2tr = btc.p2tr(userPubkeyXonly, undefined, scureRegtest, true);
    recoveryAddress = userP2tr.address!;

    // The funding wallet — a P2WPKH from the existing regtest wallet.
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

  it('builds commit → broadcasts commit → recovers postage via leaf-1 → confirms recovery on chain', async () => {
    // Phase 1: SDK build. The reveal will be discarded; only the
    // commit + recovery material are used.
    const inscribed = createInscribeTransactions({
      paymentOutput: {
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        status: { confirmed: true },
      },
      paymentPublicKey: fundingPaymentPublicKey,
      paymentAddress: fundingPaymentAddress,
      paymentPubkeyXonly: userPubkeyXonly,
      recipientAddress: recoveryAddress,
      body: new TextEncoder().encode('this inscription will be recovered, not revealed'),
      contentType: 'text/plain;charset=utf-8',
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });

    // Phase 2: sign + broadcast the commit via bitcoin-cli (the
    // external wallet signs the funding input).
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

    // Phase 3: build + sign the recovery tx via leaf 1. The reveal
    // is silently discarded — the spec simulates "reveal never
    // landed for whatever reason; user pulls the postage back".
    const recovered = buildInscribeRecoveryTx({
      commitTxid,
      recovery: inscribed.recovery,
      recoveryAddress,
      feeRatePerVbyte: FEE_RATE,
      userRecoveryPrivKey: userPrivKey,
      network: Network.Regtest,
    });
    expect(recovered.recoveryTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(recovered.recoveryAmountSats).toBeGreaterThan(0);

    // Phase 4: broadcast + confirm the recovery.
    const recoveryTxid = await postTx(recovered.recoveryHex);
    expect(recoveryTxid).toBe(recovered.recoveryTxid);
    await waitForElectrsSync(mineBlocks(1));
    const recoveryTx = await waitForTxConfirmed(recoveryTxid);
    expect(recoveryTx.status.block_hash).toBeTruthy();

    // Phase 5: the recovered amount lands at recoveryAddress.
    const recoveryUtxos = await getUtxos(recoveryAddress);
    const landedUtxo = recoveryUtxos.find(
      u => u.txid === recoveryTxid && u.value === recovered.recoveryAmountSats,
    );
    expect(landedUtxo).toBeDefined();
  });
});
