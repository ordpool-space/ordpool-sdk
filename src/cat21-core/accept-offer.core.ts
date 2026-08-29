import { firstValueFrom, from } from 'rxjs';

import { Network } from '../network';
import { OrdinalsAddress, PaymentAddress } from '../wallet/address-types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { findSignerOrThrow } from '../wallet/signers';
import { validateCat21BuyOfferPsbt } from '../cat21-offer/cat21-offer.helper';
import { Cat21OfferValidation } from '../cat21-offer/cat21-offer.types';
import { BroadcastOutcome, BroadcastPort } from './ports';

/**
 * Everything the accept-offer core needs. The SELLER accepts a buyer-built
 * buy-offer PSBT: validate it against the seller's intent, sign input 0 (their
 * cat) with SIGHASH_ALL, broadcast. There is NO coin selection here — the buyer
 * already funded the offer — so this flow carries no UtxosPort/ContentScanPort.
 */
export interface AcceptOfferCoreParams {
  walletType: KnownOrdinalWalletType;
  network: Network;
  /** Seller's ordinals identity — the cat input 0 belongs to it. */
  ordinalsAddress: string;
  /** Seller's ordinals pubkey hex (input 0's taproot internal key). */
  ordinalsPublicKey: string;
  /** The buyer-signed buy-offer PSBT. */
  offerPsbt: Uint8Array;
  /** The seller's cat UTXO the offer must spend at input 0. */
  expectedSellerUtxo: { txid: string; vout: number };
  /** Minimum acceptable net price in sats. */
  floorPriceSats: number;
  /** Where the seller must be paid (output 1). */
  expectedSellerPaymentAddress: PaymentAddress;
  /** Optional: verify the cat lands at the buyer's declared address (output 0). */
  expectedBuyerReceiveAddress?: OrdinalsAddress;
}

/**
 * Validate a buy-offer against the seller's intent WITHOUT signing — the
 * preview the accept UI shows before the seller commits. Pure.
 */
export function validateOffer(params: AcceptOfferCoreParams): Cat21OfferValidation {
  return validateCat21BuyOfferPsbt({
    psbt: params.offerPsbt,
    expectedSellerUtxo: params.expectedSellerUtxo,
    floorPriceSats: params.floorPriceSats,
    expectedSellerPaymentAddress: params.expectedSellerPaymentAddress,
    network: params.network,
    expectedBuyerReceiveAddress: params.expectedBuyerReceiveAddress,
  });
}

/**
 * Accept a buy-offer end-to-end: validate → sign the seller's cat input 0 →
 * broadcast the settled tx. Throws with the validator's reason when the PSBT
 * doesn't match the seller's intent (never signs a mismatched offer).
 * `promptForSignedPsbt` is the watch-only signing bridge (Promise form).
 */
export async function acceptOffer(
  params: AcceptOfferCoreParams,
  ports: {
    broadcast: BroadcastPort;
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Promise<string>;
  },
): Promise<BroadcastOutcome> {
  const validation = validateOffer(params);
  if (validation.ok !== true) {
    const detail = validation.detail ? ` — ${validation.detail}` : '';
    throw new Error(`Offer rejected: ${validation.reason}${detail}`);
  }

  const signer = findSignerOrThrow(params.walletType);
  const prompt = ports.promptForSignedPsbt;
  // signOfferAccept only surfaces the txid; capture the broadcast channel here.
  let channel: BroadcastOutcome['channel'] = 'mempool';
  const { txId } = await firstValueFrom(
    signer.signOfferAccept({
      psbtBytes: params.offerPsbt,
      ordinalsAddress: params.ordinalsAddress,
      ordinalsPublicKey: params.ordinalsPublicKey,
      network: params.network,
      broadcast: (txHex) =>
        from(
          ports.broadcast.broadcast(txHex).then((r) => {
            channel = r.channel;
            return r.txid;
          }),
        ),
      promptForSignedPsbt: prompt ? (unsigned) => from(prompt(unsigned)) : undefined,
    }),
  );
  return { txid: txId, channel };
}
