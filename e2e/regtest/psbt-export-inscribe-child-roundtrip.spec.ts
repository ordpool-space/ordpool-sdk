/**
 * Watch-only / PSBT-export CHILD-INSCRIBE roundtrip on regtest.
 *
 * Same external-wallet stand-in as the sibling psbt-export specs
 * (Bitcoin Core's descriptor wallet via `bitcoin-cli
 * walletprocesspsbt`), driving the production
 * `psbtExportSigner.signChildRevealParentInputs` path end-to-end:
 *
 *   1. Inscribe the PARENT to the Core wallet's own bech32m (tr()
 *      descriptor) address — commit signed via walletprocesspsbt +
 *      `signSingleFundingInput`, reveal is ephemeral-key-signed.
 *   2. Build the CHILD (`createChildInscribeTransactions`) with the
 *      parent UTXO at the wallet's tr() address; sign + broadcast the
 *      child commit the same way.
 *   3. The external wallet partial-signs the BARE wallet-facing reveal
 *      (`finalize=false`): input 0 is its own Taproot parent UTXO
 *      (key-path, signable), input 1 is the foreign ephemeral commit
 *      (untouched, `complete=false`). `signChildRevealParentInputs`
 *      consumes that via `promptForSignedPsbt`, merges input 0's
 *      signature into the FULL reveal PSBT, finalizes both inputs and
 *      broadcasts.
 *   4. Prove via stock ord: the provenance link is indexed, the child
 *      sits at its recipient, and the parent RETURNED to the wallet
 *      with its 546 sats.
 */

import { describe, expect, it } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { firstValueFrom, Observable, of } from 'rxjs';

import { createInscribeTransactions, createChildInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import { psbtExportSigner } from '../../src/wallet/signers/psbt-export.signer';
import {
  ElectrsUtxo,
  inscriptionId,
  getStockOrdInscription,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForOrdStockInscription,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC per funding UTXO
const FEE_RATE = 5;
const PSBT_WALLET = 'ordpool-e2e';

function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

const scureRegtest = toScureNetwork(Network.Regtest);

/** Fund a fresh SegWit UTXO from the regtest wallet; returns its context. */
async function freshFunding(): Promise<{ address: string; pubkey: Uint8Array; utxo: ElectrsUtxo }> {
  const address = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
  const pubkey = hex.decode(JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', address)).pubkey);
  bitcoinCliPsbtWallet('sendtoaddress', address, '1.0');
  await waitForElectrsSync(mineBlocks(1));
  const utxo = await waitForUtxoAt(address, FUND_AMOUNT_SATS);
  return { address, pubkey, utxo };
}

/**
 * The Core wallet's own Taproot address (tr() descriptor) + x-only
 * internal key parsed from getaddressinfo's concrete descriptor.
 */
function newWalletTaproot(): { address: string; script: Uint8Array; internalKey: Uint8Array } {
  const address = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32m');
  const info = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', address));
  const m = /tr\((?:\[[^\]]+\])?([0-9a-f]{64})\)/i.exec(info.desc as string);
  if (!m) throw new Error(`cannot parse tr() internal key from descriptor: ${info.desc}`);
  return { address, script: hex.decode(info.scriptPubKey), internalKey: hex.decode(m[1]) };
}

/** Sign a COMMIT via walletprocesspsbt and broadcast through the production signer. */
async function signAndBroadcastCommitViaSigner(commitPsbt: Uint8Array, paymentAddress: string, expectedTxid: string): Promise<void> {
  const processed = JSON.parse(bitcoinCliPsbtWallet(
    '-named', 'walletprocesspsbt', `psbt=${base64.encode(commitPsbt)}`, 'sign=true', 'sighashtype=ALL', 'finalize=true',
  ));
  expect(processed.complete).toBe(true);
  let txid = '';
  await firstValueFrom(psbtExportSigner.signSingleFundingInput({
    psbtBytes: commitPsbt,
    paymentAddress,
    network: Network.Regtest,
    broadcast: (txHex: string) => new Observable<string>((sub) => {
      postTx(txHex).then(id => { txid = id; sub.next(id); sub.complete(); }, err => sub.error(err));
    }),
    promptForSignedPsbt: () => of(processed.psbt as string),
  }));
  expect(txid).toBe(expectedTxid);
  mineBlocks(1);
  await waitForTxConfirmed(txid);
}

/** Poll stock ord until the inscription's satpoint becomes `expectedSatpoint`. */
async function waitForOrdStockSatpoint(id: string, expectedSatpoint: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const insc = await getStockOrdInscription(id);
    last = insc.satpoint ?? '';
    if (insc.satpoint === expectedSatpoint) return insc;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`stock ord: ${id} still at ${last}, expected ${expectedSatpoint}`);
}

describe('psbt-export signer CHILD-INSCRIBE roundtrip on regtest (external offline wallet via bitcoin-cli walletprocesspsbt)', () => {

  it('external wallet signs the reveal parent input on the bare PSBT; signChildRevealParentInputs merges + broadcasts; ord links the child, parent returns home', async () => {
    await waitForOrdStockReady(60_000);
    // Post-jubilee (regtest jubilee height 110), matching mainnet.
    await waitForElectrsSync(mineBlocks(20));

    // The parent's home: the Core wallet's own tr() descriptor address.
    const home = newWalletTaproot();

    // ---- Phase A: inscribe the PARENT into the wallet's tr() address ----
    const pf = await freshFunding();
    const parent = createInscribeTransactions({
      paymentOutput: { txid: pf.utxo.txid, vout: pf.utxo.vout, value: pf.utxo.value, status: { confirmed: true } },
      paymentPublicKey: pf.pubkey,
      paymentAddress: pf.address,
      recipientAddress: home.address,
      body: new TextEncoder().encode('<html><body>PARENT collection root (watch-only)</body></html>'),
      contentType: 'text/html',
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    await signAndBroadcastCommitViaSigner(parent.commitPsbt, pf.address, parent.commitTxid);
    const parentRevealTxid = await postTx(parent.revealHex);
    expect(parentRevealTxid).toBe(parent.revealTxid);
    const parentTip = mineBlocks(1);
    await waitForElectrsSync(parentTip);
    await waitForTxConfirmed(parentRevealTxid);

    const parentId = inscriptionId(parentRevealTxid, 0);
    await waitForOrdStockSync(parentTip);
    const parentBefore = await waitForOrdStockInscription(parentId);
    expect(parentBefore.address).toBe(home.address);
    expect(parentBefore.value).toBe(546);

    // ---- Phase B: build the CHILD, commit via the signer ----
    const cf = await freshFunding();
    const childRecipientAddr = btc.p2tr(
      schnorr.getPublicKey(secp256k1.utils.randomPrivateKey()), undefined, scureRegtest, true,
    ).address!;
    const child = createChildInscribeTransactions({
      paymentOutput: { txid: cf.utxo.txid, vout: cf.utxo.vout, value: cf.utxo.value, status: { confirmed: true } },
      paymentPublicKey: cf.pubkey,
      paymentAddress: cf.address,
      recipientAddress: childRecipientAddr,
      body: new TextEncoder().encode('<html><body>CHILD member #1 (watch-only)</body></html>'),
      contentType: 'text/html',
      feeRatePerVbyte: FEE_RATE,
      parentInscriptionId: parentId,
      parentUtxo: {
        utxo: {
          txid: parentRevealTxid,
          vout: 0,
          value: 546,
          scriptPubKey: home.script,
          tapInternalKey: home.internalKey,
        },
        returnAddress: home.address,
      },
      network: Network.Regtest,
    });
    await signAndBroadcastCommitViaSigner(child.commitPsbt, cf.address, child.commitTxid);

    // ---- Phase C: the external wallet signs the reveal's PARENT input ----
    // walletprocesspsbt on the BARE wallet-facing PSBT: input 0 (the
    // wallet's Taproot parent) gets a key-path signature; the foreign
    // ephemeral-commit input 1 stays untouched, so complete=false. No
    // sighashtype override: the bare PSBT stores none for input 0 and
    // Core's Taproot default (DEFAULT) is wire-valid here.
    const bareBase64 = base64.encode(child.revealPsbtForWallet);
    const bareSigned = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt', `psbt=${bareBase64}`, 'sign=true', 'finalize=false',
    ));
    expect(bareSigned.complete).toBe(false);

    let capturedTxHex: string | undefined;
    const signerResult = await firstValueFrom(psbtExportSigner.signChildRevealParentInputs({
      psbtBytes: child.revealPsbtForWallet,
      finalizePsbtBytes: child.revealPsbt,
      ordinalsAddress: home.address,
      ordinalsPublicKey: hex.encode(home.internalKey),
      network: Network.Regtest,
      broadcast: (txHex: string) => {
        capturedTxHex = txHex;
        return new Observable<string>((sub) => {
          postTx(txHex).then(id => { sub.next(id); sub.complete(); }, err => sub.error(err));
        });
      },
      promptForSignedPsbt: (unsigned) => {
        expect(unsigned.base64).toBe(bareBase64);
        return of(bareSigned.psbt as string);
      },
    }));
    const childRevealTxid = signerResult.txId;
    expect(capturedTxHex).toBeDefined();
    expect(childRevealTxid).toBe(child.revealTxid);
    const childTip = mineBlocks(1);
    await waitForElectrsSync(childTip);
    await waitForTxConfirmed(childRevealTxid);

    // ---- Phase D: prove via stock ord ----
    await waitForOrdStockSync(childTip);
    const childId = inscriptionId(childRevealTxid, 0);
    const childInsc = await waitForOrdStockInscription(childId);

    expect(childInsc.parents ?? []).toContain(parentId);
    expect(childInsc.number).toBeGreaterThanOrEqual(0);
    expect(childInsc.address).toBe(childRecipientAddr);
    expect(childInsc.value).toBe(546);

    // The parent moved to the child reveal's output 0 and is STILL at
    // the wallet's tr() address with its 546 sats.
    const parentAfter = await waitForOrdStockSatpoint(parentId, `${childRevealTxid}:0:0`);
    expect(parentAfter.address).toBe(home.address);
    expect(parentAfter.value).toBe(546);
    const parentReturnUtxo = await waitForUtxoAt(home.address, 546);
    expect(parentReturnUtxo.txid).toBe(childRevealTxid);
    expect(parentReturnUtxo.vout).toBe(0);
  }, 300_000);
});
