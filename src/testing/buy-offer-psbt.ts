import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import type { OfferPrevouts } from '../cat21-offer/verify-offer-input-signatures.js';

/**
 * Signed buy-offer PSBTs for specs, in the shape a buyer's wallet hands one to
 * a seller: input 0 is the seller's cat UTXO (unsigned), inputs 1..N are the
 * buyer's funding coins (signed by a buyer key the spec holds), output 0
 * carries the cat to the buyer, output 1 pays the seller `price + cat value`,
 * output 2 is the buyer's change. `nLockTime=21`, as the SDK's own builder
 * sets it (`buildCat21BuyOfferPsbt`).
 *
 * Every key is a fixed test scalar, so every address below is a real,
 * decodable mainnet address whose key a spec holds. Pure `@scure` and
 * `@noble`: runs unchanged in Node and in a browser.
 */

const BUYER_PAYMENT_KEY = hex.decode('01'.repeat(32));
const BUYER_ORDINALS_KEY = hex.decode('02'.repeat(32));
const SELLER_PAYMENT_KEY = hex.decode('03'.repeat(32));
/** The seller's taproot key, exported so a spec can sign input 0 as the seller. */
export const TEST_OFFER_SELLER_ORDINALS_KEY: Uint8Array = hex.decode('04'.repeat(32));
const STRANGER_KEY = hex.decode('05'.repeat(32));

const buyerPayment = btc.p2wpkh(secp256k1.getPublicKey(BUYER_PAYMENT_KEY, true), btc.NETWORK);
const buyerOrdinals = btc.p2tr(schnorr.getPublicKey(BUYER_ORDINALS_KEY), undefined, btc.NETWORK);
const sellerPayment = btc.p2wpkh(secp256k1.getPublicKey(SELLER_PAYMENT_KEY, true), btc.NETWORK);
const sellerOrdinalsInternalKey = schnorr.getPublicKey(TEST_OFFER_SELLER_ORDINALS_KEY);
const sellerOrdinals = btc.p2tr(sellerOrdinalsInternalKey, undefined, btc.NETWORK);

/** Address of a p2wpkh / p2tr payment built from a key we hold; always set for those types. */
function addressOf(payment: { address?: string }): string {
  if (!payment.address) throw new Error('payment has no address');
  return payment.address;
}

export const TEST_OFFER_BUYER_PAYMENT_ADDRESS = addressOf(buyerPayment);
export const TEST_OFFER_BUYER_ORDINALS_ADDRESS = addressOf(buyerOrdinals);
export const TEST_OFFER_SELLER_PAYMENT_ADDRESS = addressOf(sellerPayment);
export const TEST_OFFER_SELLER_ORDINALS_ADDRESS = addressOf(sellerOrdinals);
/** A valid address that belongs to neither party, for "pays somewhere else". */
export const TEST_OFFER_STRANGER_ADDRESS = addressOf(
  btc.p2wpkh(secp256k1.getPublicKey(STRANGER_KEY, true), btc.NETWORK),
);

/** A distinct funding txid per `n` (0..255): the byte `n` repeated 32 times. */
export function testFundingTxid(n: number): string {
  return n.toString(16).padStart(2, '0').repeat(32);
}

export interface TestBuyOfferOptions {
  /** The seller's cat UTXO, spent at input 0. */
  sellerUtxo: { txid: string; vout: number; value: number };
  /**
   * The script of the seller's cat UTXO. Default: the test seller's taproot
   * script, with its internal key set so `TEST_OFFER_SELLER_ORDINALS_KEY` can
   * sign input 0. Pass a consumer's own test wallet script when that wallet
   * is the seller; the internal key is then left unset.
   */
  sellerOrdinalsScript?: Uint8Array;
  /** What output 1 pays the seller on top of the cat value. Default 21,000 sats. */
  priceSats?: number;
  /** Where the default output 1 pays. Default: `TEST_OFFER_SELLER_PAYMENT_ADDRESS`. */
  sellerPaymentAddress?: string;
  /**
   * The buyer's funding coins, all at the buyer's payment address and all
   * signed. Default: one coin of `price + cat value + 50,000` sats, which
   * with the default 40,000-sat change leaves a 10,000-sat fee.
   */
  buyerFunding?: { txid: string; vout: number; value: number }[];
  /**
   * Outputs in order. Default: the cat to `TEST_OFFER_BUYER_ORDINALS_ADDRESS`,
   * `price + cat value` to the seller, 40,000 sats change to
   * `TEST_OFFER_BUYER_PAYMENT_ADDRESS`.
   */
  outputs?: { address: string; amount: number }[];
  /** The sighash the buyer signs with. Default SIGHASH_ALL. */
  buyerSighash?: number;
  /** Default 21. */
  lockTime?: number;
}

/** Default change: with the default funding coin it leaves a 10,000-sat fee. */
const DEFAULT_CHANGE_SATS = 40_000;
const DEFAULT_FUNDING_HEADROOM_SATS = 50_000;
const DEFAULT_PRICE_SATS = 21_000;

/**
 * Build and buyer-sign a buy-offer PSBT. Returns it as base64 and as bytes,
 * plus the `prevouts` map it signed over (every input's true script + amount,
 * keyed `"<txid>:<vout>"`). A consumer verifying the crypto gate feeds that map
 * to its electrs double so a genuine offer passes and only tampering fails; it
 * is the authoritative prevout set because the builder is what chose the
 * scripts and amounts the signatures commit to.
 */
export function buildSignedTestBuyOffer(
  opts: TestBuyOfferOptions,
): { base64: string; bytes: Uint8Array; prevouts: OfferPrevouts } {
  const priceSats = opts.priceSats ?? DEFAULT_PRICE_SATS;
  const catValue = opts.sellerUtxo.value;
  const buyerFunding = opts.buyerFunding ?? [
    { txid: testFundingTxid(0xaa), vout: 1, value: priceSats + catValue + DEFAULT_FUNDING_HEADROOM_SATS },
  ];
  const sighash = opts.buyerSighash ?? btc.SigHash.ALL;
  const outputs = opts.outputs ?? [
    { address: TEST_OFFER_BUYER_ORDINALS_ADDRESS, amount: catValue },
    { address: opts.sellerPaymentAddress ?? TEST_OFFER_SELLER_PAYMENT_ADDRESS, amount: priceSats + catValue },
    { address: TEST_OFFER_BUYER_PAYMENT_ADDRESS, amount: DEFAULT_CHANGE_SATS },
  ];

  const tx = new btc.Transaction({ lockTime: opts.lockTime ?? 21, allowUnknownOutputs: true });
  tx.addInput({
    txid: opts.sellerUtxo.txid,
    index: opts.sellerUtxo.vout,
    witnessUtxo: { script: opts.sellerOrdinalsScript ?? sellerOrdinals.script, amount: BigInt(catValue) },
    ...(opts.sellerOrdinalsScript ? {} : { tapInternalKey: sellerOrdinalsInternalKey }),
    sighashType: btc.SigHash.ALL,
  });
  for (const coin of buyerFunding) {
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      witnessUtxo: { script: buyerPayment.script, amount: BigInt(coin.value) },
      sighashType: sighash,
    });
  }
  for (const out of outputs) {
    tx.addOutput({
      script: btc.OutScript.encode(btc.Address(btc.NETWORK).decode(out.address)),
      amount: BigInt(out.amount),
    });
  }
  for (let i = 1; i <= buyerFunding.length; i++) {
    tx.signIdx(BUYER_PAYMENT_KEY, i, [sighash]);
  }
  const bytes = tx.toPSBT();

  // The prevouts the signatures commit to: input 0 is the seller cat, 1..N the
  // buyer funding coins. Exactly the scripts/amounts set as each input's
  // witnessUtxo above, so a verifier fed this map accepts the genuine offer.
  const prevouts: OfferPrevouts = new Map();
  prevouts.set(`${opts.sellerUtxo.txid}:${opts.sellerUtxo.vout}`, {
    script: opts.sellerOrdinalsScript ?? sellerOrdinals.script,
    amountSats: catValue,
  });
  for (const coin of buyerFunding) {
    prevouts.set(`${coin.txid}:${coin.vout}`, {
      script: buyerPayment.script,
      amountSats: coin.value,
    });
  }

  return { base64: base64.encode(bytes), bytes, prevouts };
}
