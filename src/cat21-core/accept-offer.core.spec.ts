import { describe, expect, it, jest } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { toPaymentAddress } from '../wallet/address-types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { buildCat21BuyOfferPsbt } from '../cat21-offer/cat21-offer.helper';
import { prepareBuyOfferBuyerInput } from '../cat21-offer/cat21-offer-input-adapter';
import { BroadcastPort } from './ports';
import { AcceptOfferCoreParams, acceptOffer, validateOffer } from './accept-offer.core';

// Plain NODE unit test — no Angular, no jsdom. Builds a REAL buyer-signed offer.

const SELLER_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000002');
const SELLER_P2TR = btc.p2tr(SELLER_KEY.slice(1, 33), undefined, btc.NETWORK);
const SELLER_PAYMENT = btc.p2wpkh(SELLER_KEY, btc.NETWORK).address!;

// Controlled buyer keypair so we can actually sign the buyer input.
const BUYER_PRIV = hex.decode('0101010101010101010101010101010101010101010101010101010101010101');
const BUYER_PUB = secp256k1.getPublicKey(BUYER_PRIV, true);
const BUYER_PAYMENT = btc.p2wpkh(BUYER_PUB, btc.NETWORK).address!;
const BUYER_RECEIVE = btc.p2tr(BUYER_PUB.slice(1, 33), undefined, btc.NETWORK).address!;

const CAT = { txid: 'a'.repeat(64), vout: 0, value: 546 };
const PRICE = 21_000;

function buildOfferPsbt(): Uint8Array {
  const buyerInput = prepareBuyOfferBuyerInput({
    utxo: { txid: 'b'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
    paymentPublicKey: BUYER_PUB,
    paymentAddress: BUYER_PAYMENT,
    isSimulation: false,
    network: Network.Mainnet,
  });
  const built = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.cat21wallet,
    network: Network.Mainnet,
    sellerInput: { txid: CAT.txid, vout: CAT.vout, value: CAT.value, scriptPubKey: SELLER_P2TR.script },
    buyerInputs: [buyerInput],
    destinations: {
      buyerReceiveAddress: BUYER_RECEIVE,
      sellerPaymentAddress: SELLER_PAYMENT,
      buyerChangeAddress: BUYER_PAYMENT,
    },
    priceSats: PRICE,
    feeSats: 1_000,
  });
  // Buyer signs input 1 (their funding) with SIGHASH_ALL; input 0 (seller cat)
  // stays for the seller — exactly the bid a real create-offer produces.
  const tx = btc.Transaction.fromPSBT(built.psbt);
  tx.signIdx(BUYER_PRIV, 1);
  return tx.toPSBT();
}

const params = (over: Partial<AcceptOfferCoreParams> = {}): AcceptOfferCoreParams => ({
  walletType: KnownOrdinalWalletType.cat21wallet,
  network: Network.Mainnet,
  ordinalsAddress: SELLER_P2TR.address!,
  ordinalsPublicKey: hex.encode(SELLER_KEY.slice(1, 33)),
  offerPsbt: buildOfferPsbt(),
  expectedSellerUtxo: { txid: CAT.txid, vout: CAT.vout },
  floorPriceSats: PRICE,
  expectedSellerPaymentAddress: toPaymentAddress(SELLER_PAYMENT),
  ...over,
});

const broadcastPort = (): BroadcastPort => ({ broadcast: async () => ({ txid: 'settle-txid', channel: 'mempool' }) });

describe('accept-offer.core — validateOffer', () => {
  it('accepts a well-formed offer at the floor price', () => {
    const v = validateOffer(params());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.pricePaidSats).toBe(PRICE);
  });

  it('rejects when the floor price is above the offer price', () => {
    const v = validateOffer(params({ floorPriceSats: PRICE + 1 }));
    expect(v.ok).toBe(false);
  });

  it('rejects when the seller payment address does not match', () => {
    const v = validateOffer(params({ expectedSellerPaymentAddress: toPaymentAddress(BUYER_PAYMENT) }));
    expect(v.ok).toBe(false);
  });
});

describe('accept-offer.core — acceptOffer', () => {
  it('refuses to sign a mismatched offer (validator reason surfaced)', async () => {
    await expect(
      acceptOffer(params({ floorPriceSats: PRICE + 5_000 }), { broadcast: broadcastPort() }),
    ).rejects.toThrow(/Offer rejected/);
  });

  it('a valid offer reaches the seller signer (watch-only prompt fires)', async () => {
    const prompt = jest.fn((u: { base64: string; hex: string }) => Promise.resolve(u.base64));
    await acceptOffer(params({ walletType: KnownOrdinalWalletType.xpub }), {
      broadcast: broadcastPort(),
      promptForSignedPsbt: prompt,
    }).catch(() => undefined);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
