/**
 * Watch-only / PSBT-export OFFER roundtrips on regtest — both roles.
 *
 * Same external-wallet stand-in as the sibling psbt-export specs:
 * Bitcoin Core's descriptor wallet via `bitcoin-cli walletprocesspsbt`
 * (the canonical BIP-174 signer; a faithful proxy for Sparrow /
 * Electrum / Coldcard / Ledger / Trezor).
 *
 * Role 1 — the watch-only user is the BUYER (`signOfferCreatePsbt`):
 *   walletprocesspsbt with `finalize=false` signs ONLY the wallet's own
 *   funding input 1 and leaves the seller's foreign cat input 0
 *   untouched (`complete=false` is the expected partial-sign shape).
 *   The raw-key seller then validates, signs input 0, finalizes and
 *   broadcasts. This is the exact Sparrow "Sign without finalizing"
 *   marketplace flow.
 *
 * Role 2 — the watch-only user is the SELLER (`signOfferAccept`):
 *   the cat lives at the wallet's own bech32m (tr() descriptor)
 *   address; a raw-key buyer builds + pre-signs the offer;
 *   walletprocesspsbt signs the Taproot cat input 0 and finalizes
 *   everything (the buyer's P2WPKH partialSig on input 1 is
 *   finalizable without the key); `psbtExportSigner.signOfferAccept`
 *   broadcasts the settled trade.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { firstValueFrom, Observable, of } from 'rxjs';
import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { createTransaction } from '../../src/cat21-mint/cat21.service.helper';
import { TxnOutput } from '../../src/cat21-mint/cat21.service.types';
import { buildCat21BuyOfferPsbt, validateCat21BuyOfferPsbt } from '../../src/cat21-offer/cat21-offer.helper';
import { Network, toScureNetwork } from '../../src/network';
import { toPaymentAddress } from '../../src/wallet/address-types';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import { psbtExportSigner } from '../../src/wallet/signers/psbt-export.signer';
import {
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
const OFFER_FEE_SATS = 1_500;
const PRICE_SATS = 50_000;
const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC

const PSBT_WALLET = 'ordpool-e2e';

function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

/**
 * walletprocesspsbt. `sighashtype=ALL` matches the SDK builders'
 * stored PSBT_IN_SIGHASH_TYPE (Core's DEFAULT conflicts on Taproot
 * inputs). `finalize` is the role switch: the buyer partial-signs
 * (`false`, foreign input 0 stays open, complete=false); the seller
 * finish-signs (`true`, everything finalizable, complete=true).
 */
function externalWalletSign(unsignedPsbtBase64: string, finalize: boolean): { psbt: string; complete: boolean } {
  const processed = JSON.parse(bitcoinCliPsbtWallet(
    '-named', 'walletprocesspsbt',
    `psbt=${unsignedPsbtBase64}`,
    'sign=true',
    'sighashtype=ALL',
    `finalize=${finalize}`,
  ));
  return { psbt: processed.psbt as string, complete: processed.complete as boolean };
}

/** New funded P2WPKH payment identity in the Core wallet. */
async function newFundedWalletPayment(): Promise<{ address: string; publicKey: Uint8Array; utxo: { txid: string; vout: number; value: number } }> {
  const address = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
  const info = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', address));
  bitcoinCliPsbtWallet('sendtoaddress', address, '1.0');
  await waitForElectrsSync(mineBlocks(1));
  const utxo = await waitForUtxoAt(address, FUND_AMOUNT_SATS);
  return { address, publicKey: hex.decode(info.pubkey), utxo };
}

/**
 * The Core wallet's own Taproot address (tr() descriptor) + its x-only
 * internal key, parsed from getaddressinfo's concrete descriptor
 * `tr([origin]<64-hex>)#checksum`.
 */
function newWalletTaproot(): { address: string; script: Uint8Array; internalKeyHex: string } {
  const address = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32m');
  const info = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', address));
  const desc: string = info.desc;
  const m = /tr\((?:\[[^\]]+\])?([0-9a-f]{64})\)/i.exec(desc);
  if (!m) throw new Error(`cannot parse tr() internal key from descriptor: ${desc}`);
  return { address, script: hex.decode(info.scriptPubKey), internalKeyHex: m[1] };
}


describe('psbt-export signer OFFER roundtrips on regtest (external offline wallet via bitcoin-cli walletprocesspsbt)', () => {

  const regtestNetwork = toScureNetwork(Network.Regtest);

  beforeAll(async () => {
    // Warm the electrs tip once; each test funds its own identities.
    await waitForElectrsSync(mineBlocks(1));
  });


  it('BUYER role: walletprocesspsbt partial-signs input 1 (finalize=false), signOfferCreatePsbt emits the artifact, the raw-key seller settles; cat lands at the buyer', async () => {

    // ── Raw-key seller with a cat at P2WPKH ──
    const sellerPriv = secp256k1.utils.randomPrivateKey();
    const sellerPub = secp256k1.getPublicKey(sellerPriv, true);
    const sellerP2wpkh = btc.p2wpkh(sellerPub, regtestNetwork);
    const sellerAddress = sellerP2wpkh.address!;
    rpc('-rpcwallet=' + PSBT_WALLET, 'sendtoaddress', sellerAddress, '0.01');
    await waitForElectrsSync(mineBlocks(1));
    const sellerFunding = await waitForUtxoAt(sellerAddress, 1_000_000);

    const sellerMint = createTransaction(
      KnownOrdinalWalletType.xpub,
      sellerAddress,
      { txid: sellerFunding.txid, vout: sellerFunding.vout, value: sellerFunding.value, status: { confirmed: true } } as TxnOutput,
      sellerPub,
      sellerAddress,
      MINT_FEE,
      false,
      Network.Regtest,
    );
    sellerMint.tx.signIdx(sellerPriv, 0, [btc.SigHash.ALL]);
    sellerMint.tx.finalize();
    const sellerMintTxid = await postTx(sellerMint.tx.hex);
    await waitForElectrsSync(mineBlocks(1));
    const catUtxo = await waitForUtxoMatching(
      sellerAddress,
      u => u.txid === sellerMintTxid && u.value === CAT21_POSTAGE_SATS,
      `seller cat ${sellerMintTxid}:0`,
    );

    // ── Watch-only BUYER: Core wallet funding + Taproot receive ──
    const buyer = await newFundedWalletPayment();
    const buyerReceive = newWalletTaproot();

    const offer = buildCat21BuyOfferPsbt({
      walletType: KnownOrdinalWalletType.xpub,
      network: Network.Regtest,
      sellerInput: {
        txid: catUtxo.txid,
        vout: catUtxo.vout,
        value: catUtxo.value,
        scriptPubKey: sellerP2wpkh.script,
      },
      buyerInputs: [{
        txid: buyer.utxo.txid,
        vout: buyer.utxo.vout,
        value: buyer.utxo.value,
        scriptPubKey: btc.p2wpkh(buyer.publicKey, regtestNetwork).script,
      }],
      destinations: {
        buyerReceiveAddress: buyerReceive.address,
        sellerPaymentAddress: sellerAddress,
        buyerChangeAddress: buyer.address,
      },
      priceSats: PRICE_SATS,
      feeSats: OFFER_FEE_SATS,
    });

    // External wallet partial-signs: ONLY the buyer's input 1; the
    // foreign cat input 0 stays unsigned, so complete MUST be false.
    const unsignedBase64 = base64.encode(offer.psbt);
    const partial = externalWalletSign(unsignedBase64, false);
    expect(partial.complete).toBe(false);

    const artifactBytes = await firstValueFrom(psbtExportSigner.signOfferCreatePsbt({
      psbtBytes: offer.psbt,
      paymentAddress: buyer.address,
      fundingInputCount: 1,
      network: Network.Regtest,
      promptForSignedPsbt: (unsigned) => {
        expect(unsigned.base64).toBe(unsignedBase64);
        return of(partial.psbt);
      },
    }));

    // The artifact carries the buyer's partialSig on input 1 and NO
    // signature on the seller's input 0.
    const artifactTx = btc.Transaction.fromPSBT(artifactBytes, { allowUnknownInputs: true });
    expect(artifactTx.lockTime).toBe(CAT21_LOCKTIME);
    expect(artifactTx.getInput(1).partialSig?.length).toBe(1);
    expect(artifactTx.getInput(0).partialSig ?? []).toHaveLength(0);

    // ── Seller side: validate, sign input 0, finalize, broadcast ──
    const validation = validateCat21BuyOfferPsbt({
      psbt: artifactBytes,
      expectedSellerUtxo: { txid: catUtxo.txid, vout: catUtxo.vout },
      floorPriceSats: PRICE_SATS,
      expectedSellerPaymentAddress: toPaymentAddress(sellerAddress),
      network: Network.Regtest,
    });
    expect(validation.ok).toBe(true);

    const settle = btc.Transaction.fromPSBT(artifactBytes, { allowUnknownInputs: true });
    settle.signIdx(sellerPriv, 0, [btc.SigHash.ALL]);
    settle.finalize();
    const settleTxid = await postTx(settle.hex);
    await waitForElectrsSync(mineBlocks(1));

    const settleTx = await waitForTxConfirmed(settleTxid);
    expect(settleTx.locktime).toBe(CAT21_LOCKTIME);
    assertAllInputsSighashAll(settleTx);
    // Cat (546, output 0) at the buyer's Taproot receive address; the
    // seller got paid price + postage at output 1.
    const buyerUtxos = await getUtxos(buyerReceive.address);
    expect(buyerUtxos.find(u => u.txid === settleTxid && u.vout === 0)?.value).toBe(CAT21_POSTAGE_SATS);
    const sellerUtxos = await getUtxos(sellerAddress);
    expect(sellerUtxos.find(u => u.txid === settleTxid && u.vout === 1)?.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);
    const cat = Cat21ParserService.parse(settleTx);
    expect(cat).not.toBeNull();
    expect(cat!.type).toBe(DigitalArtifactType.Cat21);
  });


  it('SELLER role: cat at the wallet Taproot address, raw-key buyer pre-signs, walletprocesspsbt finish-signs input 0, signOfferAccept broadcasts; buyer owns the cat', async () => {

    // ── Watch-only SELLER: cat minted to the wallet's own tr() address ──
    const seller = await newFundedWalletPayment();
    const catHome = newWalletTaproot();

    const builtMint = createTransaction(
      KnownOrdinalWalletType.xpub,
      catHome.address,
      { txid: seller.utxo.txid, vout: seller.utxo.vout, value: seller.utxo.value, status: { confirmed: true } } as TxnOutput,
      seller.publicKey,
      seller.address,
      MINT_FEE,
      false,
      Network.Regtest,
    );
    const mintSigned = externalWalletSign(base64.encode(builtMint.tx.toPSBT(0)), true);
    expect(mintSigned.complete).toBe(true);
    let mintTxid = '';
    await firstValueFrom(psbtExportSigner.signSingleFundingInput({
      psbtBytes: builtMint.tx.toPSBT(0),
      paymentAddress: seller.address,
      network: Network.Regtest,
      broadcast: (txHex: string) => new Observable<string>((sub) => {
        postTx(txHex).then(txid => { mintTxid = txid; sub.next(txid); sub.complete(); }, err => sub.error(err));
      }),
      promptForSignedPsbt: () => of(mintSigned.psbt),
    }));
    await waitForElectrsSync(mineBlocks(1));
    const catUtxo = await waitForUtxoMatching(
      catHome.address,
      u => u.txid === mintTxid && u.value === CAT21_POSTAGE_SATS,
      `seller(watch-only) cat ${mintTxid}:0`,
    );

    // ── Raw-key BUYER builds + pre-signs the offer ──
    const buyerPriv = secp256k1.utils.randomPrivateKey();
    const buyerPub = secp256k1.getPublicKey(buyerPriv, true);
    const buyerP2wpkh = btc.p2wpkh(buyerPub, regtestNetwork);
    const buyerAddress = buyerP2wpkh.address!;
    const buyerReceive = btc.p2tr(buyerPub.subarray(1, 33), undefined, regtestNetwork, true);
    rpc('-rpcwallet=' + PSBT_WALLET, 'sendtoaddress', buyerAddress, '0.01');
    await waitForElectrsSync(mineBlocks(1));
    const buyerFunding = await waitForUtxoAt(buyerAddress, 1_000_000);

    const offer = buildCat21BuyOfferPsbt({
      walletType: KnownOrdinalWalletType.xpub,
      network: Network.Regtest,
      sellerInput: {
        txid: catUtxo.txid,
        vout: catUtxo.vout,
        value: catUtxo.value,
        scriptPubKey: catHome.script,
      },
      buyerInputs: [{
        txid: buyerFunding.txid,
        vout: buyerFunding.vout,
        value: buyerFunding.value,
        scriptPubKey: buyerP2wpkh.script,
      }],
      destinations: {
        buyerReceiveAddress: buyerReceive.address!,
        sellerPaymentAddress: seller.address,
        buyerChangeAddress: buyerAddress,
      },
      priceSats: PRICE_SATS,
      feeSats: OFFER_FEE_SATS,
    });
    const buyerSigned = btc.Transaction.fromPSBT(offer.psbt, { allowUnknownInputs: true });
    buyerSigned.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);
    const buyerSignedBytes = buyerSigned.toPSBT();

    // Seller-side validation gate (the same gate a hot wallet runs).
    const validation = validateCat21BuyOfferPsbt({
      psbt: buyerSignedBytes,
      expectedSellerUtxo: { txid: catUtxo.txid, vout: catUtxo.vout },
      floorPriceSats: PRICE_SATS,
      expectedSellerPaymentAddress: toPaymentAddress(seller.address),
      network: Network.Regtest,
    });
    expect(validation.ok).toBe(true);

    // External wallet finish-signs: its Taproot cat input 0 plus
    // finalization of the buyer's already-signed P2WPKH input 1.
    const unsignedBase64 = base64.encode(buyerSignedBytes);
    const accepted = externalWalletSign(unsignedBase64, true);
    expect(accepted.complete).toBe(true);

    let capturedTxHex: string | undefined;
    const signerResult = await firstValueFrom(psbtExportSigner.signOfferAccept({
      psbtBytes: buyerSignedBytes,
      ordinalsAddress: catHome.address,
      ordinalsPublicKey: catHome.internalKeyHex,
      network: Network.Regtest,
      broadcast: (txHex: string) => {
        capturedTxHex = txHex;
        return new Observable<string>((sub) => {
          postTx(txHex).then(txid => { sub.next(txid); sub.complete(); }, err => sub.error(err));
        });
      },
      promptForSignedPsbt: (unsigned) => {
        expect(unsigned.base64).toBe(unsignedBase64);
        return of(accepted.psbt);
      },
    }));
    const acceptTxid = signerResult.txId;
    expect(capturedTxHex).toBeDefined();

    await waitForElectrsSync(mineBlocks(1));
    const acceptTx = await waitForTxConfirmed(acceptTxid);
    expect(acceptTx.locktime).toBe(CAT21_LOCKTIME);
    assertAllInputsSighashAll(acceptTx);
    // Cat at the buyer's Taproot address; seller paid price + postage.
    const buyerUtxos = await getUtxos(buyerReceive.address!);
    expect(buyerUtxos.find(u => u.txid === acceptTxid && u.vout === 0)?.value).toBe(CAT21_POSTAGE_SATS);
    const sellerUtxos = await getUtxos(seller.address);
    expect(sellerUtxos.find(u => u.txid === acceptTxid && u.vout === 1)?.value).toBe(PRICE_SATS + CAT21_POSTAGE_SATS);
    const cat = Cat21ParserService.parse(acceptTx);
    expect(cat).not.toBeNull();
    expect(cat!.type).toBe(DigitalArtifactType.Cat21);
  });
});
