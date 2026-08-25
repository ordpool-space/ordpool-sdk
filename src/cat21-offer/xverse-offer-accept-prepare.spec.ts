import { describe, expect, it } from '@jest/globals';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of } from 'rxjs';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  prepareOfferAcceptWalletFacing,
  mergeParentSigAndBroadcast,
} from '../wallet/signers/child-reveal-finalize.helper';
import { buildCat21BuyOfferPsbt } from './cat21-offer.helper';

/**
 * Pins the Xverse offer-accept fix mechanics WITHOUT the real wallet: a
 * buyer-signed offer PSBT (input 1 partial-signed, input 0 = the seller's
 * Taproot cat, unsigned, no tapInternalKey) is reshaped by
 * prepareOfferAcceptWalletFacing into a bare wallet-facing copy (input 0
 * gains its tapInternalKey, input 1 stripped to witnessUtxo). The seller
 * signs input 0 key-path on the bare copy; mergeParentSigAndBroadcast lifts
 * that sig onto the full buyer-signed PSBT and BOTH inputs finalize to a
 * valid wire tx. This is the exact sequence the Xverse signOfferAccept
 * override runs; only the "seller signs input 0" step is the real wallet in
 * the e2e (here it's a raw key).
 */
const NETWORK = btc.NETWORK;
const CAT_POSTAGE = 546;

function buildBuyerSignedOffer(): {
  fullBuyerSigned: Uint8Array;
  sellerXOnly: Uint8Array;
  sellerPriv: Uint8Array;
} {
  const sellerPriv = secp256k1.utils.randomPrivateKey();
  const sellerXOnly = schnorr.getPublicKey(sellerPriv);
  const sellerP2tr = btc.p2tr(sellerXOnly, undefined, NETWORK);

  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyerPub = secp256k1.getPublicKey(buyerPriv, true);
  const buyerP2wpkh = btc.p2wpkh(buyerPub, NETWORK);

  const offer = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.xverse,
    network: Network.Mainnet,
    sellerInput: {
      txid: '11'.repeat(32),
      vout: 0,
      value: CAT_POSTAGE,
      scriptPubKey: sellerP2tr.script,
    },
    buyerInputs: [{
      txid: '22'.repeat(32),
      vout: 1,
      value: 50_000,
      scriptPubKey: buyerP2wpkh.script,
    }],
    destinations: {
      buyerReceiveAddress: buyerP2wpkh.address!,
      sellerPaymentAddress: buyerP2wpkh.address!,
      buyerChangeAddress: buyerP2wpkh.address!,
    },
    priceSats: 21_000,
    feeSats: 1_000,
  });

  // Buyer signs ONLY input 1 (partial sig, not finalized) — exactly what the
  // e2e buyer does before handing the PSBT to the seller wallet.
  const tx = btc.Transaction.fromPSBT(offer.psbt, { allowUnknownInputs: true });
  tx.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);
  return { fullBuyerSigned: tx.toPSBT(0), sellerXOnly, sellerPriv };
}

describe('prepareOfferAcceptWalletFacing + mergeParentSigAndBroadcast (Xverse offer-accept fix)', () => {
  it('the full buyer-signed offer has lockTime=21, input 0 unsigned + no tapInternalKey, input 1 partial-signed', () => {
    const { fullBuyerSigned } = buildBuyerSignedOffer();
    const full = btc.Transaction.fromPSBT(fullBuyerSigned, { allowUnknownInputs: true });
    expect(full.lockTime).toBe(21);
    expect(full.getInput(0).tapKeySig).toBeUndefined();
    expect(full.getInput(0).tapInternalKey).toBeUndefined();
    expect(full.getInput(1).partialSig).toBeDefined();
  });

  it('the bare wallet-facing copy carries input 0 tapInternalKey + strips input 1 to witnessUtxo, same lockTime/outputs', () => {
    const { fullBuyerSigned, sellerXOnly } = buildBuyerSignedOffer();
    const bare = prepareOfferAcceptWalletFacing(fullBuyerSigned, sellerXOnly);
    const bareTx = btc.Transaction.fromPSBT(bare, { allowUnknownInputs: true });
    const full = btc.Transaction.fromPSBT(fullBuyerSigned, { allowUnknownInputs: true });

    expect(bareTx.lockTime).toBe(21);
    expect(bareTx.inputsLength).toBe(2);
    expect(bareTx.outputsLength).toBe(full.outputsLength);
    // input 0 now has the seller's internal key; input 1's buyer sig is gone.
    expect(bareTx.getInput(0).tapInternalKey).toEqual(sellerXOnly);
    expect(bareTx.getInput(1).partialSig).toBeUndefined();
    // outputs preserved byte-for-byte (SIGHASH_ALL commits to them).
    for (let i = 0; i < full.outputsLength; i++) {
      expect(bareTx.getOutput(i).script).toEqual(full.getOutput(i).script);
      expect(bareTx.getOutput(i).amount).toEqual(full.getOutput(i).amount);
    }
  });

  it('seller signs input 0 on the bare copy; merge onto full finalizes BOTH inputs to a valid wire tx (lockTime=21)', async () => {
    const { fullBuyerSigned, sellerXOnly, sellerPriv } = buildBuyerSignedOffer();
    const bare = prepareOfferAcceptWalletFacing(fullBuyerSigned, sellerXOnly);

    // Real wallet step, here a raw key: sign input 0 key-path (BIP-86 tweaked).
    const bareTx = btc.Transaction.fromPSBT(bare, { allowUnknownInputs: true });
    bareTx.signIdx(sellerPriv, 0);
    expect(bareTx.getInput(0).tapKeySig).toBeDefined();
    const signedBare = bareTx.toPSBT(0);

    // The exact production tail: merge input-0 sig onto the full PSBT +
    // finalize + broadcast. Capture the wire hex via the broadcast callback.
    let wireHex = '';
    await firstValueFrom(mergeParentSigAndBroadcast(signedBare, fullBuyerSigned, (hex) => {
      wireHex = hex;
      return of('txid-unused');
    }));

    const wire = btc.Transaction.fromRaw(Uint8Array.from(Buffer.from(wireHex, 'hex')));
    expect(wire.lockTime).toBe(21);
    expect(wire.inputsLength).toBe(2);
    // Both inputs carry a finalized witness (input 0 Taproot key-path,
    // input 1 P2WPKH) — the whole point: no foreign input left the seller
    // unable to sign, and the buyer's sig survived the merge.
    expect(wire.getInput(0).finalScriptWitness).toBeDefined();
    expect(wire.getInput(1).finalScriptWitness).toBeDefined();
  });
});
