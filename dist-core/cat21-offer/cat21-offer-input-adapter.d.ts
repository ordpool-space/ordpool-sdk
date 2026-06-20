import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { Cat21OfferBuyerInput } from './cat21-offer.types';
/**
 * Layer-2 input adapter for the BUYER side of the CAT-21 buy-offer
 * flow.
 *
 * The buyer-initiated offer PSBT structurally has:
 *   - Input 0:  seller's cat UTXO (unsigned). The SELLER side
 *               doesn't go through this adapter — the buyer just
 *               references the seller's outpoint + scriptPubKey,
 *               learned out-of-band (marketplace, ord lookup, etc.).
 *   - Inputs 1..N: buyer's funding UTXOs. THIS adapter prepares
 *               those, dispatching via the address-format-driven
 *               `buildInputScript`.
 *
 * Pure function. No I/O, no Angular.
 */
export interface PrepareBuyOfferBuyerInputArgs {
    utxo: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    isSimulation: boolean;
    network: Network;
}
export declare function prepareBuyOfferBuyerInput(args: PrepareBuyOfferBuyerInputArgs): Cat21OfferBuyerInput;
//# sourceMappingURL=cat21-offer-input-adapter.d.ts.map