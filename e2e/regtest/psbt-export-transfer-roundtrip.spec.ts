/**
 * Watch-only / PSBT-export TRANSFER roundtrip on regtest.
 *
 * Same external-wallet stand-in as `psbt-export-roundtrip.spec.ts`:
 * Bitcoin Core's descriptor wallet via `bitcoin-cli walletprocesspsbt`
 * is the canonical BIP-174 signer, so a PSBT it signs is a faithful
 * proxy for Sparrow / Electrum / Coldcard / Ledger / Trezor.
 *
 * The transfer-specific twist: input 0 is the CAT's Taproot UTXO, so
 * the cat must live at an address the external wallet can actually
 * sign. We mint the cat to the wallet's own `bech32m` address (a tr()
 * descriptor Core signs natively), then transfer it to an external
 * P2WPKH destination.
 *
 * End-to-end flow this spec pins:
 *   1. Cat home  = `getnewaddress "" bech32m` (Taproot, tr() descriptor).
 *      Funding   = `getnewaddress "" bech32`  (P2WPKH) + its pubkey.
 *   2. Fund the payment address, SDK-build a CAT-21 mint with the
 *      bech32m address as recipient, walletprocesspsbt-sign, broadcast
 *      via `psbtExportSigner.signSingleFundingInput`. Cat (546 sats)
 *      lands at the bech32m address; change at the payment address.
 *   3. SDK-build the transfer (`buildCat21TransferPsbt`): input 0 =
 *      the cat UTXO, input 1 = the mint change, output 0 = the cat to
 *      an external P2WPKH destination, change back to the payment
 *      address. lockTime=21.
 *   4. Sign via walletprocesspsbt (both inputs are wallet-owned:
 *      Taproot cat + P2WPKH funding; `complete=true`).
 *   5. Drive `psbtExportSigner.signTransfer` with a stubbed
 *      `promptForSignedPsbt` that returns the walletprocesspsbt
 *      output; the signer finalizes (already final) and broadcasts.
 *   6. Assert via electrs: the 546-sat output 0 sits at the
 *      destination, lockTime=21, every input signs SIGHASH_ALL, and
 *      ordpool-parser reads the transfer tx as a CAT-21 (every
 *      cat-touching tx we build re-mints).
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { firstValueFrom, Observable, of } from 'rxjs';
import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { createTransaction } from '../../src/cat21-mint/cat21.service.helper';
import { TxnOutput } from '../../src/cat21-mint/cat21.service.types';
import { buildCat21TransferPsbt } from '../../src/cat21-transfer/cat21-transfer.helper';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import { psbtExportSigner } from '../../src/wallet/signers/psbt-export.signer';
import {
  ElectrsUtxo,
  assertAllInputsSighashAll,
  getUtxos,
  waitForTxConfirmed,
  waitForUtxoMatching,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForUtxoAt,
} from './regtest-helpers';


const CAT21_LOCKTIME = 21;
const CAT21_POSTAGE_SATS = 546;
const MINT_FEE = BigInt(2_000);
const TRANSFER_FEE_SATS = 1_500;
const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC

const PSBT_WALLET = 'ordpool-e2e';

function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

/**
 * walletprocesspsbt with sign+finalize; asserts completeness.
 *
 * `sighashtype=ALL` is required: the SDK builders store
 * PSBT_IN_SIGHASH_TYPE = ALL (0x01) on every input, and Core's default
 * ("DEFAULT", 0x00) conflicts with that on TAPROOT inputs — Core rejects
 * the whole PSBT with "Specified sighash value does not match value
 * stored in PSBT". Passing ALL matches the stored value on both the
 * taproot cat input and the P2WPKH funding input.
 */
function externalWalletSign(unsignedPsbtBase64: string): string {
  const processed = JSON.parse(bitcoinCliPsbtWallet(
    '-named', 'walletprocesspsbt',
    `psbt=${unsignedPsbtBase64}`,
    'sign=true',
    'sighashtype=ALL',
    'finalize=true',
  ));
  expect(processed.complete).toBe(true);
  return processed.psbt as string;
}


describe('psbt-export signer TRANSFER roundtrip on regtest (external offline wallet via bitcoin-cli walletprocesspsbt)', () => {

  const regtestNetwork = toScureNetwork(Network.Regtest);

  let paymentAddress: string;
  let paymentPublicKey: Uint8Array;
  let catHomeAddress: string;
  let catHomeScript: Uint8Array;
  let fundingUtxo: ElectrsUtxo;

  beforeAll(async () => {
    // The external wallet's P2WPKH payment address (funds mint + fees).
    paymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', paymentAddress));
    if (!addrInfo.pubkey) {
      throw new Error(`getaddressinfo did not return pubkey for ${paymentAddress}`);
    }
    paymentPublicKey = hex.decode(addrInfo.pubkey);

    // The cat's home: the wallet's OWN Taproot address (tr() descriptor),
    // so walletprocesspsbt can sign the cat input of the transfer.
    catHomeAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32m');
    const catHomeInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', catHomeAddress));
    catHomeScript = hex.decode(catHomeInfo.scriptPubKey);

    bitcoinCliPsbtWallet('sendtoaddress', paymentAddress, '1.0');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    fundingUtxo = await waitForUtxoAt(paymentAddress, FUND_AMOUNT_SATS);
  });


  it('mints to the wallet Taproot address, transfers via walletprocesspsbt + psbtExportSigner.signTransfer, cat lands at the destination', async () => {

    // ── Phase 1: mint a cat TO the wallet's bech32m address ──
    const paymentOutput: TxnOutput = {
      txid: fundingUtxo.txid,
      vout: fundingUtxo.vout,
      value: fundingUtxo.value,
      status: { confirmed: true },
    };
    const builtMint = createTransaction(
      KnownOrdinalWalletType.xpub,
      catHomeAddress,
      paymentOutput,
      paymentPublicKey,
      paymentAddress,
      MINT_FEE,
      false,
      Network.Regtest,
    );
    expect(builtMint.tx.lockTime).toBe(CAT21_LOCKTIME);
    const mintSigned = externalWalletSign(base64.encode(builtMint.tx.toPSBT(0)));

    let mintTxid = '';
    await firstValueFrom(psbtExportSigner.signSingleFundingInput({
      psbtBytes: builtMint.tx.toPSBT(0),
      paymentAddress,
      network: Network.Regtest,
      broadcast: (txHex: string) => new Observable<string>((sub) => {
        postTx(txHex).then(txid => { mintTxid = txid; sub.next(txid); sub.complete(); }, err => sub.error(err));
      }),
      promptForSignedPsbt: () => of(mintSigned),
    }));
    expect(mintTxid).toMatch(/^[0-9a-f]{64}$/);

    const tipAfterMint = mineBlocks(1);
    await waitForElectrsSync(tipAfterMint);
    // Cat at the wallet's Taproot address, change back at the payment address.
    const catUtxo = await waitForUtxoMatching(
      catHomeAddress,
      u => u.txid === mintTxid && u.value === CAT21_POSTAGE_SATS,
      `cat ${mintTxid}:0 at ${catHomeAddress}`,
    );
    const changeUtxo = await waitForUtxoMatching(
      paymentAddress,
      u => u.txid === mintTxid && u.value > CAT21_POSTAGE_SATS,
      `mint change of ${mintTxid} at ${paymentAddress}`,
    );

    // ── Phase 2: transfer the cat to an external P2WPKH destination ──
    const destPriv = secp256k1.utils.randomPrivateKey();
    const destP2wpkh = btc.p2wpkh(secp256k1.getPublicKey(destPriv, true), regtestNetwork);
    const destinationAddress = destP2wpkh.address!;

    const paymentScript = btc.p2wpkh(paymentPublicKey, regtestNetwork).script;
    const transfer = buildCat21TransferPsbt({
      walletType: KnownOrdinalWalletType.xpub,
      network: Network.Regtest,
      catUtxo: {
        txid: catUtxo.txid,
        vout: catUtxo.vout,
        value: catUtxo.value,
        scriptPubKey: catHomeScript,
      },
      fundingInputs: [{
        txid: changeUtxo.txid,
        vout: changeUtxo.vout,
        value: changeUtxo.value,
        scriptPubKey: paymentScript,
      }],
      destinations: {
        recipientAddress: destinationAddress,
        senderChangeAddress: paymentAddress,
      },
      feeSats: TRANSFER_FEE_SATS,
    });

    // ── Phase 3: external sign + signTransfer broadcast ──
    const unsignedTransferBase64 = base64.encode(transfer.psbt);
    const transferSigned = externalWalletSign(unsignedTransferBase64);

    let capturedTxHex: string | undefined;
    const signerResult = await firstValueFrom(psbtExportSigner.signTransfer({
      psbtBytes: transfer.psbt,
      ordinalsAddress: catHomeAddress,
      paymentAddress,
      fundingInputCount: 1,
      network: Network.Regtest,
      broadcast: (txHex: string) => {
        capturedTxHex = txHex;
        return new Observable<string>((sub) => {
          postTx(txHex).then(txid => { sub.next(txid); sub.complete(); }, err => sub.error(err));
        });
      },
      promptForSignedPsbt: (unsigned) => {
        expect(unsigned.base64).toBe(unsignedTransferBase64);
        return of(transferSigned);
      },
    }));
    const transferTxid = signerResult.txId;
    expect(capturedTxHex).toBeDefined();

    // ── Phase 4: on-chain assertions ──
    const tipAfterTransfer = mineBlocks(1);
    await waitForElectrsSync(tipAfterTransfer);

    const transferTx = await waitForTxConfirmed(transferTxid);
    expect(transferTx.status.confirmed).toBe(true);
    expect(transferTx.locktime).toBe(CAT21_LOCKTIME);
    assertAllInputsSighashAll(transferTx);

    // The cat's 546-sat output 0 sits at the destination.
    const destUtxos = await getUtxos(destinationAddress);
    const catAtDest = destUtxos.find(u => u.txid === transferTxid && u.vout === 0);
    expect(catAtDest?.value).toBe(CAT21_POSTAGE_SATS);
    // The cat is gone from its previous home.
    const oldHome = await getUtxos(catHomeAddress);
    expect(oldHome.find(u => u.txid === catUtxo.txid && u.vout === catUtxo.vout)).toBeUndefined();

    // Every cat-touching tx we build re-mints: the parser reads the
    // transfer tx itself as a CAT-21 (lockTime=21).
    const cat = Cat21ParserService.parse(transferTx);
    expect(cat).not.toBeNull();
    expect(cat!.type).toBe(DigitalArtifactType.Cat21);
  });
});
