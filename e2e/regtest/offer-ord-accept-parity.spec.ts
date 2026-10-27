/**
 * Proves: a buy-offer built, buyer-signed and finalised by the SDK is accepted
 *         by ord's own `wallet offer accept` (cat21-ord, which carries upstream
 *         ord #4553: "inputs may not specify any sighash type"). The seller is
 *         an ord wallet holding the cat; ord runs every pre-signing check in
 *         --dry-run and answers with the txid of our transaction.
 * Control: the same offer with `sighashType: SIGHASH_ALL` written on the buyer
 *         input, left unfinalised (what the SDK handed out before), is refused
 *         by ord with its sighash message, so the green case cannot pass
 *         because ord accepts anything.
 * Real:   bitcoind, electrs, cat21-ord and its wallet, all regtest.
 */
import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { buildCat21BuyOfferPsbt } from '../../src/cat21-offer/cat21-offer.helper';
import { finalizeOfferBuyerInputs } from '../../src/cat21-offer/finalize-offer-buyer-inputs';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  catInscriptionId,
  mineBlocks,
  ordAcceptOfferDryRun,
  ordCliErrorSays,
  ordCreateWallet,
  postTx,
  rpc,
  waitForCatAtAddress,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const SELLER_WALLET = 'offer-accept-seller';
const FEE_SATS = 1_000;
const PRICE_SATS = 50_000;
const CAT_SATS = 9_000;

describe('ord wallet offer accept takes an SDK-built offer', () => {
  const network = toScureNetwork(Network.Regtest);
  const minterPriv = secp256k1.utils.randomPrivateKey();
  const minter = btc.p2wpkh(secp256k1.getPublicKey(minterPriv, true), network);
  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyer = btc.p2wpkh(secp256k1.getPublicKey(buyerPriv, true), network);

  let sellerCatAddress: string;
  let sellerPaymentAddress: string;
  let cat: { txid: string; inscriptionId: string };
  let buyerCoin: { txid: string; vout: number; value: number };

  beforeAll(async () => {
    let tip = mineBlocks(3);
    await waitForElectrsSync(tip);
    await waitForOrdReady();
    await waitForOrdSync(tip);

    sellerCatAddress = ordCreateWallet(SELLER_WALLET);
    sellerPaymentAddress = ordCreateWallet(SELLER_WALLET);

    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', minter.address!, '0.5');
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', buyer.address!, '0.5');
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);
    const funding = await waitForUtxoAt(minter.address!, 50_000_000);
    const buyerUtxo = await waitForUtxoAt(buyer.address!, 50_000_000);
    buyerCoin = { txid: buyerUtxo.txid, vout: buyerUtxo.vout, value: buyerUtxo.value };

    // A cat on a 9000-sat UTXO at the ord wallet: lockTime 21 makes output 0 a cat.
    const mint = new btc.Transaction({ lockTime: 21 });
    mint.addInput({
      txid: funding.txid,
      index: funding.vout,
      sequence: 0xfffffffe,
      witnessUtxo: { script: minter.script, amount: BigInt(funding.value) },
    });
    mint.addOutputAddress(sellerCatAddress, BigInt(CAT_SATS), network);
    mint.addOutputAddress(minter.address!, BigInt(funding.value - CAT_SATS - FEE_SATS), network);
    mint.signIdx(minterPriv, 0);
    mint.finalize();
    const mintTxid = await postTx(mint.hex);
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(mintTxid);
    await waitForOrdSync(tip);

    const inscriptionId = catInscriptionId(mintTxid);
    const indexed = await waitForCatAtAddress(inscriptionId, sellerCatAddress);
    expect(indexed.value).toBe(CAT_SATS);
    cat = { txid: mintTxid, inscriptionId };
  }, 180_000);

  function buildOffer(): btc.Transaction {
    const built = buildCat21BuyOfferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Regtest,
      sellerInput: {
        txid: cat.txid,
        vout: 0,
        value: CAT_SATS,
        scriptPubKey: btc.OutScript.encode(btc.Address(network).decode(sellerCatAddress)),
      },
      buyerInputs: [{ ...buyerCoin, scriptPubKey: buyer.script }],
      destinations: {
        buyerReceiveAddress: buyer.address!,
        sellerPaymentAddress,
        buyerChangeAddress: buyer.address!,
      },
      priceSats: PRICE_SATS,
      feeSats: FEE_SATS,
    });
    return btc.Transaction.fromPSBT(built.psbt, { allowUnknownInputs: true });
  }

  it('accepts the offer the SDK hands out: no input specifies a sighash type, buyer input finalised', () => {
    const offer = buildOffer();
    offer.signIdx(buyerPriv, 1);
    const handedOut = btc.Transaction.fromPSBT(finalizeOfferBuyerInputs(offer.toPSBT()));

    for (let i = 0; i < handedOut.inputsLength; i++) {
      expect(handedOut.getInput(i).sighashType).toBeUndefined();
    }
    expect(handedOut.getInput(1).finalScriptWitness).toHaveLength(2);
    expect(handedOut.getInput(0).finalScriptWitness).toBeUndefined();

    const accepted = ordAcceptOfferDryRun(cat.inscriptionId, PRICE_SATS, base64.encode(handedOut.toPSBT()), SELLER_WALLET);
    const txid = hex.encode(sha256(sha256(handedOut.toBytes(false, false))).reverse());
    expect(accepted.txid).toBe(txid);
  });

  it('refuses an offer whose buyer input specifies SIGHASH_ALL and is left unfinalised', () => {
    const offer = buildOffer();
    offer.updateInput(1, { sighashType: btc.SigHash.ALL });
    offer.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);
    const outpoint = `${buyerCoin.txid}:${buyerCoin.vout}`;

    let refusal: unknown = null;
    try {
      ordAcceptOfferDryRun(cat.inscriptionId, PRICE_SATS, base64.encode(offer.toPSBT()), SELLER_WALLET);
    } catch (e) {
      refusal = e;
    }
    expect(ordCliErrorSays(refusal, `input \`${outpoint}\` specifies sighash type`)).toBe(true);
  });
});
