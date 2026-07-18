import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { attachDummyBuyerSig } from '../testing/fixtures';
import { toPaymentAddress } from '../wallet/address-types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  buildCat21BuyOfferPsbt,
  validateCat21BuyOfferPsbt,
} from '../cat21-offer/cat21-offer.helper';
import {
  buildAskQueryParams,
  buildBuyOfferQueryParams,
  parseAskQueryParams,
  parseBuyOfferQueryParams,
} from './permalink.helper';

// ---------------------------------------------------------------------------
// End-to-end round-trip that would have caught the 2026-07-18 make-offer
// autofill bug at the SDK layer. Every stage uses the shipped SDK
// helpers — no orchestrator stubs, no frontend stubs — and the split
// wallet fixture proves the seller-payment address survives every hop
// without contamination from the ordinals context.
// ---------------------------------------------------------------------------

// Two independent public keys so the seller's ordinals ≠ payment
// address structurally, and the buyer's addresses are their own third
// key. Any address-swap bug at any hop would produce a validator
// rejection at the end of the chain.
const SELLER_ORDINALS_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000002');
const SELLER_PAYMENT_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000003');
const BUYER_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000004');

const sellerOrdinalsScript = btc.p2tr(SELLER_ORDINALS_KEY.slice(1, 33), undefined, btc.TEST_NETWORK);
const sellerPaymentScript = btc.p2wpkh(SELLER_PAYMENT_KEY, btc.TEST_NETWORK);
const buyerPaymentScript = btc.p2wpkh(BUYER_KEY, btc.TEST_NETWORK);
const buyerOrdinalsScript = btc.p2tr(BUYER_KEY.slice(1, 33), undefined, btc.TEST_NETWORK);

const SELLER_ORDINALS_ADDRESS = sellerOrdinalsScript.address!;
const SELLER_PAYMENT_ADDRESS = toPaymentAddress(sellerPaymentScript.address!);
const BUYER_PAYMENT_ADDRESS = buyerPaymentScript.address!;
const BUYER_ORDINALS_ADDRESS = buyerOrdinalsScript.address!;

const attachBuyerSig = (psbtBytes: Uint8Array) => attachDummyBuyerSig(psbtBytes, BUYER_KEY);

// Sanity: the three addresses must be structurally different so the
// round-trip test isn't accidentally passing on address equality.
describe('trade-flow-roundtrip — fixture sanity', () => {
  it('the four addresses are pairwise distinct', () => {
    const set = new Set([
      SELLER_ORDINALS_ADDRESS,
      SELLER_PAYMENT_ADDRESS,
      BUYER_PAYMENT_ADDRESS,
      BUYER_ORDINALS_ADDRESS,
    ]);
    expect(set.size).toBe(4);
  });

  it('SELLER_ORDINALS is a taproot address (bc1p… / tb1p…) — that is where cats live', () => {
    expect(SELLER_ORDINALS_ADDRESS.startsWith('tb1p') || SELLER_ORDINALS_ADDRESS.startsWith('bc1p')).toBe(true);
  });

  it('SELLER_PAYMENT is a P2WPKH address (bc1q… / tb1q…) — different address type from ordinals on purpose', () => {
    expect(SELLER_PAYMENT_ADDRESS.startsWith('tb1q') || SELLER_PAYMENT_ADDRESS.startsWith('bc1q')).toBe(true);
  });
});

describe('trade-flow-roundtrip — URL → PSBT → validator, addresses survive every hop', () => {

  it('seller.paymentAddress travels via `payTo` URL param, buyer builds correct PSBT, seller validator accepts', () => {
    // ------- Stage 1: seller's device builds the ask permalink -----
    const askParams = buildAskQueryParams({
      askSats: 21_000,
      sellerPaymentAddress: SELLER_PAYMENT_ADDRESS,
    });
    expect(askParams['payTo']).toBe(SELLER_PAYMENT_ADDRESS);
    // Simulate the URL round-trip (the buyer's browser gets it as a string).
    const askUrl = new URLSearchParams(askParams).toString();

    // ------- Stage 2: buyer's device parses the ask -----------------
    // The `cat` link on cat/:catNumber uses buildBuyOfferQueryParams
    // internally when redirecting to /dashboard/trade/make. Simulate
    // that pass-through: parse the ask, forward into a buy-offer
    // query, then parse that at the make-offer page.
    const parsedAsk = parseAskQueryParams(new URLSearchParams(askUrl));
    expect(parsedAsk.sellerPaymentAddress).toBe(SELLER_PAYMENT_ADDRESS);
    expect(parsedAsk.askSats).toBe(21_000);

    const buyOfferQuery = buildBuyOfferQueryParams({
      catNumber: 42,
      askSats: parsedAsk.askSats!,
      sellerPaymentAddress: parsedAsk.sellerPaymentAddress!,
    });
    expect(buyOfferQuery['payTo']).toBe(SELLER_PAYMENT_ADDRESS);

    const parsedBuy = parseBuyOfferQueryParams(buyOfferQuery);
    expect(parsedBuy.catNumber).toBe(42);
    expect(parsedBuy.askSats).toBe(21_000);
    // CRITICAL: the parsed sellerPaymentAddress equals the seller's
    // PAYMENT address (from the wallet), not any ordinals address.
    expect(parsedBuy.sellerPaymentAddress).toBe(SELLER_PAYMENT_ADDRESS);
    expect(parsedBuy.sellerPaymentAddress).not.toBe(SELLER_ORDINALS_ADDRESS);

    // ------- Stage 3: buyer builds the offer PSBT -------------------
    // The frontend's Cat21CreateOfferOrchestrator.createOffer() calls
    // buildCat21BuyOfferPsbt with (parsed.sellerPaymentAddress) as
    // destinations.sellerPaymentAddress. Reproduce that call directly
    // (no orchestrator; the orchestrator is tested elsewhere).
    const built = buildCat21BuyOfferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Testnet3,
      sellerInput: {
        txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        vout: 0,
        value: 546,
        scriptPubKey: sellerOrdinalsScript.script,
      },
      buyerInputs: [
        {
          txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          vout: 1,
          value: 50_000,
          scriptPubKey: buyerPaymentScript.script,
        },
      ],
      destinations: {
        buyerReceiveAddress: BUYER_ORDINALS_ADDRESS,
        sellerPaymentAddress: parsedBuy.sellerPaymentAddress!,
        buyerChangeAddress: BUYER_PAYMENT_ADDRESS,
      },
      priceSats: 21_000,
      feeSats: 1_000,
    });

    // ------- Stage 4: seller's device validates the offer -----------
    // Cat21AcceptOfferOrchestrator.validateOffer() calls this with
    // expectedSellerPaymentAddress = wallet.paymentAddress from the
    // seller's connected wallet.
    const result = validateCat21BuyOfferPsbt({
      psbt: attachBuyerSig(built.psbt),
      expectedSellerUtxo: {
        txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        vout: 0,
      },
      floorPriceSats: 21_000,
      // The seller's wallet — the address they EXPECT the payment at.
      expectedSellerPaymentAddress: SELLER_PAYMENT_ADDRESS,
      network: Network.Testnet3,
    });

    // If ANY hop dropped or mis-routed the seller's payment address,
    // this end-to-end assert fails. That's the whole point of the
    // round-trip.
    expect(result.ok).toBe(true);
  });

  it('a legacy ask link without `payTo` still parses cleanly (sellerPaymentAddress = null) — buyer must ask the seller for the address', () => {
    // v0-style ask, before the payTo hop was added.
    const legacyAsk = buildAskQueryParams({ askSats: 21_000 });
    expect(legacyAsk['payTo']).toBeUndefined();
    const parsed = parseAskQueryParams(new URLSearchParams(legacyAsk));
    expect(parsed.askSats).toBe(21_000);
    expect(parsed.sellerPaymentAddress).toBeNull();
  });

  it('regression: if the buyer builds the PSBT with the seller\'s ordinals address (the bug that shipped), the seller\'s validator rejects with `payment-output-wrong-address`', () => {
    // Reproduce the buggy code path — feed the seller\'s ORDINALS
    // address as the payment destination. The validator on the
    // seller\'s side (expecting their PAYMENT address) must refuse.
    const built = buildCat21BuyOfferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Testnet3,
      sellerInput: {
        txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        vout: 0,
        value: 546,
        scriptPubKey: sellerOrdinalsScript.script,
      },
      buyerInputs: [
        {
          txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          vout: 1,
          value: 50_000,
          scriptPubKey: buyerPaymentScript.script,
        },
      ],
      destinations: {
        buyerReceiveAddress: BUYER_ORDINALS_ADDRESS,
        // The bug: seller's ordinals address as the payment destination.
        sellerPaymentAddress: SELLER_ORDINALS_ADDRESS,
        buyerChangeAddress: BUYER_PAYMENT_ADDRESS,
      },
      priceSats: 21_000,
      feeSats: 1_000,
    });
    const result = validateCat21BuyOfferPsbt({
      psbt: attachBuyerSig(built.psbt),
      expectedSellerUtxo: {
        txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        vout: 0,
      },
      floorPriceSats: 21_000,
      expectedSellerPaymentAddress: SELLER_PAYMENT_ADDRESS,
      network: Network.Testnet3,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('payment-output-wrong-address');
    }
  });
});
