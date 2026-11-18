/**
 * @test-kind unit
 * Real:   validateCat21BuyOfferPsbt, createOfferCounterparties, counterpartyOfScript, evaluateAgentPolicyCaps,
 *         buildSignedTestBuyOffer (ordpool-sdk/testing)
 * Faked:  nothing
 * Proves: an accepted offer names its buyer as every output address except the seller's payment (output 1), once
 *         each; a create-offer names its seller as the payment address plus the cat UTXO's address; a script that is
 *         no address becomes `script:<hex>`; and those lists, fed to the agent policy, deny a party that is not on
 *         the allowlist and pass one that is
 */
import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { evaluateAgentPolicyCaps } from '../agent-mode/agent-policy.helper.js';
import { AgentActionContext, AgentPolicy } from '../agent-mode/agent-policy.types.js';
import { Network } from '../network.js';
import {
  buildSignedTestBuyOffer,
  TEST_OFFER_BUYER_ORDINALS_ADDRESS,
  TEST_OFFER_BUYER_PAYMENT_ADDRESS,
  TEST_OFFER_SELLER_ORDINALS_ADDRESS,
  TEST_OFFER_SELLER_PAYMENT_ADDRESS,
  TEST_OFFER_STRANGER_ADDRESS,
  testFundingTxid,
} from '../testing.js';
import { toPaymentAddress } from '../wallet/address-types.js';
import { validateCat21BuyOfferPsbt } from './cat21-offer.helper.js';
import { counterpartyOfScript, createOfferCounterparties } from './offer-counterparties.js';

const CAT = { txid: testFundingTxid(0x21), vout: 0, value: 9_000 };
const PRICE = 21_000;

const validate = (psbt: Uint8Array) =>
  validateCat21BuyOfferPsbt({
    psbt,
    expectedSellerUtxo: { txid: CAT.txid, vout: CAT.vout },
    floorPriceSats: PRICE,
    expectedSellerPaymentAddress: toPaymentAddress(TEST_OFFER_SELLER_PAYMENT_ADDRESS),
  });

const buyerOf = (outputs: { address: string; amount: number }[]): string[] | string => {
  const result = validate(buildSignedTestBuyOffer({ sellerUtxo: CAT, outputs }).bytes);
  return result.ok ? result.buyerAddresses : `${result.reason}: ${result.detail}`;
};

describe('validateCat21BuyOfferPsbt names the buyer', () => {
  it('every output but the seller payment, in output order', () => {
    expect(buyerOf([
      { address: TEST_OFFER_BUYER_ORDINALS_ADDRESS, amount: CAT.value },
      { address: TEST_OFFER_SELLER_PAYMENT_ADDRESS, amount: PRICE + CAT.value },
      { address: TEST_OFFER_BUYER_PAYMENT_ADDRESS, amount: 30_000 },
      { address: TEST_OFFER_STRANGER_ADDRESS, amount: 5_000 },
    ])).toEqual([TEST_OFFER_BUYER_ORDINALS_ADDRESS, TEST_OFFER_BUYER_PAYMENT_ADDRESS, TEST_OFFER_STRANGER_ADDRESS]);
  });

  it('an address paid twice is listed once', () => {
    expect(buyerOf([
      { address: TEST_OFFER_BUYER_ORDINALS_ADDRESS, amount: CAT.value },
      { address: TEST_OFFER_SELLER_PAYMENT_ADDRESS, amount: PRICE + CAT.value },
      { address: TEST_OFFER_BUYER_ORDINALS_ADDRESS, amount: 40_000 },
    ])).toEqual([TEST_OFFER_BUYER_ORDINALS_ADDRESS]);
  });
});

describe('createOfferCounterparties names the seller', () => {
  const catScript = btc.OutScript.encode(btc.Address(btc.NETWORK).decode(TEST_OFFER_SELLER_ORDINALS_ADDRESS));

  it('the payment address and the cat UTXO address', () => {
    expect(createOfferCounterparties({
      sellerPaymentAddress: TEST_OFFER_SELLER_PAYMENT_ADDRESS,
      targetCatScriptPubKey: catScript,
      network: Network.Mainnet,
    })).toEqual([TEST_OFFER_SELLER_PAYMENT_ADDRESS, TEST_OFFER_SELLER_ORDINALS_ADDRESS]);
  });

  it('once, when the seller is paid at the cat address', () => {
    expect(createOfferCounterparties({
      sellerPaymentAddress: TEST_OFFER_SELLER_ORDINALS_ADDRESS,
      targetCatScriptPubKey: catScript,
      network: Network.Mainnet,
    })).toEqual([TEST_OFFER_SELLER_ORDINALS_ADDRESS]);
  });
});

describe('counterpartyOfScript', () => {
  it('a script that is no address becomes script:<hex>, which no allowlist entry equals', () => {
    const opReturn = btc.Script.encode(['RETURN', new Uint8Array([1, 2, 3])]);

    expect(counterpartyOfScript(opReturn, Network.Mainnet)).toBe(`script:${hex.encode(opReturn)}`);
  });
});

describe('the named parties gate the agent policy', () => {
  const policy = (allowed: string[]): AgentPolicy => ({
    enabled: true,
    maxSpendPerActionSats: 1_000_000,
    dailyCapSats: 1_000_000,
    maxFeeRateSatPerVbyte: 100,
    floorPriceSatsPerCat: 0,
    allowedCounterparties: allowed,
  });
  const accept = (counterpartyAddresses: string[]): AgentActionContext => ({
    kind: 'cat21_accept_offer',
    spendSats: 0,
    feeRateSatPerVbyte: 1,
    spentTodaySats: 0,
    receivePriceSats: PRICE,
    counterpartyAddresses,
    ownAddresses: [TEST_OFFER_SELLER_PAYMENT_ADDRESS, TEST_OFFER_SELLER_ORDINALS_ADDRESS],
  });

  it('accept-offer: a buyer change address not on the allowlist is denied, naming it', () => {
    const buyer = buyerOf([
      { address: TEST_OFFER_BUYER_ORDINALS_ADDRESS, amount: CAT.value },
      { address: TEST_OFFER_SELLER_PAYMENT_ADDRESS, amount: PRICE + CAT.value },
      { address: TEST_OFFER_STRANGER_ADDRESS, amount: 40_000 },
    ]);
    if (typeof buyer === 'string') throw new Error(buyer);

    expect(evaluateAgentPolicyCaps(policy([TEST_OFFER_BUYER_ORDINALS_ADDRESS]), accept(buyer)))
      .toEqual({ allowed: false, reason: 'counterparty-not-allowed', detail: TEST_OFFER_STRANGER_ADDRESS });
    expect(evaluateAgentPolicyCaps(policy([TEST_OFFER_BUYER_ORDINALS_ADDRESS, TEST_OFFER_STRANGER_ADDRESS]), accept(buyer)))
      .toEqual({ allowed: true });
  });
});
