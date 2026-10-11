import { describe, expect, it } from '@jest/globals';
import { schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { validateCat21BuyOfferPsbt } from '../cat21-offer/cat21-offer.helper.js';
import { Network } from '../network.js';
import {
  buildSignedTestBuyOffer,
  signTestBip322Message,
  TEST_OFFER_BUYER_ORDINALS_ADDRESS,
  TEST_OFFER_BUYER_PAYMENT_ADDRESS,
  TEST_OFFER_SELLER_ORDINALS_ADDRESS,
  TEST_OFFER_SELLER_ORDINALS_KEY,
  TEST_OFFER_SELLER_PAYMENT_ADDRESS,
  TEST_OFFER_STRANGER_ADDRESS,
  testFundingTxid,
  testTaprootAddress,
} from '../testing.js';
import { toOrdinalsAddress, toPaymentAddress } from '../wallet/address-types.js';
import { verifyBip322Signature } from '../wallet/verify-bip322-signature.js';

// Runs in both the node and the jsdom suite, which is what shows the builders
// are browser-safe as well as Node-safe.

const CAT = { txid: testFundingTxid(0x11), vout: 0, value: 9_000 };

const validate = (psbt: Uint8Array, over: Partial<Parameters<typeof validateCat21BuyOfferPsbt>[0]> = {}) =>
  validateCat21BuyOfferPsbt({
    psbt,
    expectedSellerUtxo: { txid: CAT.txid, vout: CAT.vout },
    floorPriceSats: 21_000,
    expectedSellerPaymentAddress: toPaymentAddress(TEST_OFFER_SELLER_PAYMENT_ADDRESS),
    ...over,
  });

describe('buildSignedTestBuyOffer', () => {
  it('passes the SDK validator, including every marketplace-side gate', () => {
    const { bytes } = buildSignedTestBuyOffer({ sellerUtxo: CAT });
    expect(
      validate(bytes, {
        expectedBuyerReceiveAddress: toOrdinalsAddress(TEST_OFFER_BUYER_ORDINALS_ADDRESS),
        expectedBuyerChangeAddress: toPaymentAddress(TEST_OFFER_BUYER_PAYMENT_ADDRESS),
        expectedExactPrice: 21_000,
      }),
    ).toEqual({ ok: true, pricePaidSats: 21_000, postageSats: 9_000 });
  });

  it('returns the same PSBT as base64 and as bytes', () => {
    const offer = buildSignedTestBuyOffer({ sellerUtxo: CAT });
    expect(base64.decode(offer.base64)).toEqual(offer.bytes);
  });

  it('lays out the ord buy-offer shape with nLockTime 21 and a 10,000-sat fee once the seller signs', () => {
    const tx = btc.Transaction.fromPSBT(buildSignedTestBuyOffer({ sellerUtxo: CAT, priceSats: 30_000 }).bytes);
    expect(tx.lockTime).toBe(21);
    expect(hex.encode(tx.getInput(0).txid!)).toBe(CAT.txid);
    const outputs = Array.from({ length: tx.outputsLength }, (_, i) => {
      const o = tx.getOutput(i);
      return [btc.Address(btc.NETWORK).encode(btc.OutScript.decode(o.script!)), Number(o.amount)];
    });
    expect(outputs).toEqual([
      [TEST_OFFER_BUYER_ORDINALS_ADDRESS, 9_000],
      [TEST_OFFER_SELLER_PAYMENT_ADDRESS, 39_000],
      [TEST_OFFER_BUYER_PAYMENT_ADDRESS, 40_000],
    ]);

    tx.signIdx(TEST_OFFER_SELLER_ORDINALS_KEY, 0, [btc.SigHash.ALL]);
    tx.finalize();
    expect(Number(tx.fee)).toBe(10_000);
  });

  it('signs every buyer funding input', () => {
    const { bytes } = buildSignedTestBuyOffer({
      sellerUtxo: CAT,
      buyerFunding: [
        { txid: testFundingTxid(0xa1), vout: 0, value: 20_000 },
        { txid: testFundingTxid(0xa2), vout: 3, value: 60_000 },
      ],
    });
    const tx = btc.Transaction.fromPSBT(bytes);
    expect(tx.inputsLength).toBe(3);
    expect([1, 2].map((i) => tx.getInput(i).partialSig?.length)).toEqual([1, 1]);
    expect(validate(bytes)).toEqual({ ok: true, pricePaidSats: 21_000, postageSats: 9_000 });
  });

  it('spends a consumer test wallet script at input 0 when given one', () => {
    const consumerScript = btc.p2tr(schnorr.getPublicKey(hex.decode('09'.repeat(32))), undefined, btc.NETWORK).script;
    const { bytes } = buildSignedTestBuyOffer({ sellerUtxo: CAT, sellerOrdinalsScript: consumerScript });
    const input0 = btc.Transaction.fromPSBT(bytes).getInput(0);
    expect(input0.witnessUtxo?.script).toEqual(consumerScript);
    expect(input0.tapInternalKey).toBeUndefined();
    expect(validate(bytes)).toEqual({ ok: true, pricePaidSats: 21_000, postageSats: 9_000 });
  });

  it('defaults input 0 to the test seller, whose key is exported', () => {
    const input0 = btc.Transaction.fromPSBT(buildSignedTestBuyOffer({ sellerUtxo: CAT }).bytes).getInput(0);
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(input0.witnessUtxo!.script))).toBe(
      TEST_OFFER_SELLER_ORDINALS_ADDRESS,
    );
  });

  it('a buyer signing SINGLE|ANYONECANPAY is rejected as not SIGHASH_ALL', () => {
    const { bytes } = buildSignedTestBuyOffer({
      sellerUtxo: CAT,
      buyerSighash: btc.SigHash.SINGLE_ANYONECANPAY,
    });
    expect(validate(bytes)).toMatchObject({ ok: false, reason: 'sighash-not-all' });
  });

  it('output 1 paying a stranger is rejected', () => {
    const { bytes } = buildSignedTestBuyOffer({
      sellerUtxo: CAT,
      outputs: [
        { address: TEST_OFFER_BUYER_ORDINALS_ADDRESS, amount: 9_000 },
        { address: TEST_OFFER_STRANGER_ADDRESS, amount: 30_000 },
        { address: TEST_OFFER_BUYER_PAYMENT_ADDRESS, amount: 40_000 },
      ],
    });
    expect(validate(bytes)).toMatchObject({ ok: false, reason: 'payment-output-wrong-address' });
  });

  it('honours a seller payment address the caller passes', () => {
    const { bytes } = buildSignedTestBuyOffer({ sellerUtxo: CAT, sellerPaymentAddress: TEST_OFFER_STRANGER_ADDRESS });
    expect(
      validate(bytes, { expectedSellerPaymentAddress: toPaymentAddress(TEST_OFFER_STRANGER_ADDRESS) }),
    ).toEqual({ ok: true, pricePaidSats: 21_000, postageSats: 9_000 });
  });
});

describe('signTestBip322Message', () => {
  const KEY = hex.decode('07'.repeat(32));
  const MESSAGE = 'cat21 session test message';

  it('verifies under verifyBip322Signature for its mainnet address', () => {
    const signatureBase64 = signTestBip322Message({ privateKey: KEY, message: MESSAGE });
    expect(verifyBip322Signature({ address: testTaprootAddress(KEY), message: MESSAGE, signatureBase64 })).toEqual({
      ok: true,
    });
  });

  it('verifies for its regtest address', () => {
    const address = testTaprootAddress(KEY, Network.Regtest);
    expect(address.startsWith('bcrt1p')).toBe(true);
    const signatureBase64 = signTestBip322Message({ privateKey: KEY, message: MESSAGE, network: Network.Regtest });
    expect(verifyBip322Signature({ address, message: MESSAGE, signatureBase64 })).toEqual({ ok: true });
  });

  it('is the serialized one-item witness a wallet returns: 0x01, 0x40, 64 signature bytes', () => {
    const bytes = base64.decode(signTestBip322Message({ privateKey: KEY, message: MESSAGE }));
    expect(bytes.length).toBe(66);
    expect([bytes[0], bytes[1]]).toEqual([0x01, 0x40]);
  });

  it('does not verify over a different message', () => {
    const signatureBase64 = signTestBip322Message({ privateKey: KEY, message: MESSAGE });
    expect(
      verifyBip322Signature({ address: testTaprootAddress(KEY), message: `${MESSAGE}!`, signatureBase64 }),
    ).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('does not verify for another key\'s address', () => {
    const signatureBase64 = signTestBip322Message({ privateKey: KEY, message: MESSAGE });
    const other = testTaprootAddress(hex.decode('08'.repeat(32)));
    expect(verifyBip322Signature({ address: other, message: MESSAGE, signatureBase64 })).toEqual({
      ok: false,
      reason: 'signature-does-not-verify',
    });
  });
});
