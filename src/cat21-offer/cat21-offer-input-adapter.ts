import { prepareCat21Input, PrepareCat21InputArgs } from '../cat21-script/prepare-cat21-input';
import { Cat21OfferBuyerInput } from './cat21-offer.types';

/**
 * Layer-2 input adapter for the BUYER side of the CAT-21 buy-offer flow.
 *
 * The buyer-initiated offer PSBT has the seller's cat UTXO at input 0
 * (unsigned, referenced out-of-band — NOT prepared here) and the
 * buyer's funding UTXOs at inputs 1..N (prepared here). Thin wrapper
 * over the shared `prepareCat21Input`.
 */
export type PrepareBuyOfferBuyerInputArgs = PrepareCat21InputArgs;

export function prepareBuyOfferBuyerInput(args: PrepareBuyOfferBuyerInputArgs): Cat21OfferBuyerInput {
  return prepareCat21Input(args);
}
