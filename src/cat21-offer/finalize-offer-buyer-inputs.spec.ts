import { describe, expect, it } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Network } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { buildCat21BuyOfferPsbt } from './cat21-offer.helper.js';
import { finalizeOfferBuyerInputs } from './finalize-offer-buyer-inputs.js';

const buyerPriv = secp256k1.utils.randomPrivateKey();
const buyer = btc.p2wpkh(secp256k1.getPublicKey(buyerPriv, true), btc.TEST_NETWORK);
const seller = btc.p2wpkh(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true), btc.TEST_NETWORK);

function offer(): btc.Transaction {
  const built = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.cat21wallet,
    network: Network.Testnet3,
    sellerInput: { txid: '01'.repeat(32), vout: 0, value: 9_000, scriptPubKey: seller.script },
    buyerInputs: [{ txid: '02'.repeat(32), vout: 1, value: 100_000, scriptPubKey: buyer.script }],
    destinations: {
      buyerReceiveAddress: buyer.address!,
      sellerPaymentAddress: seller.address!,
      buyerChangeAddress: buyer.address!,
    },
    priceSats: 21_000,
    feeSats: 1_000,
  });
  return btc.Transaction.fromPSBT(built.psbt);
}

describe('finalizeOfferBuyerInputs', () => {
  it('turns the buyer partialSig into the final [signature, pubkey] witness and leaves the seller input unsigned', () => {
    const tx = offer();
    tx.signIdx(buyerPriv, 1);
    const sig = tx.getInput(1).partialSig![0][1];

    const out = btc.Transaction.fromPSBT(finalizeOfferBuyerInputs(tx.toPSBT()));
    const buyerInput = out.getInput(1);
    expect(buyerInput.finalScriptWitness).toEqual([sig, secp256k1.getPublicKey(buyerPriv, true)]);
    expect(buyerInput.partialSig).toBeUndefined();
    expect(buyerInput.sighashType).toBeUndefined();
    expect(out.getInput(0).finalScriptWitness).toBeUndefined();
    expect(out.getInput(0).partialSig).toBeUndefined();
  });

  it('clears a sighashType the buyer wallet wrote while signing', () => {
    const tx = offer();
    tx.updateInput(1, { sighashType: btc.SigHash.ALL });
    tx.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);

    const out = btc.Transaction.fromPSBT(finalizeOfferBuyerInputs(tx.toPSBT()));
    expect(out.getInput(1).sighashType).toBeUndefined();
    expect(out.getInput(1).finalScriptWitness).toHaveLength(2);
  });

  it('keeps a buyer input the wallet already finalised byte for byte', () => {
    const tx = offer();
    tx.signIdx(buyerPriv, 1);
    tx.finalizeIdx(1);
    const witness = tx.getInput(1).finalScriptWitness;

    const out = btc.Transaction.fromPSBT(finalizeOfferBuyerInputs(tx.toPSBT()));
    expect(out.getInput(1).finalScriptWitness).toEqual(witness);
  });

  it('refuses a buyer signature made with SIGHASH_SINGLE|ANYONECANPAY', () => {
    const weak = btc.SigHash.SINGLE_ANYONECANPAY;
    const tx = offer();
    tx.updateInput(1, { sighashType: weak });
    tx.signIdx(buyerPriv, 1, [weak]);

    expect(() => finalizeOfferBuyerInputs(tx.toPSBT())).toThrow(
      'finalizeOfferBuyerInputs: buyer input 1 ECDSA sig sighash flag byte = 0x83, expected 0x01',
    );
  });
});
