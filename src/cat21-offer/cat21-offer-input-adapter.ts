import { hex } from '@scure/base';

import { getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
import { Network, toScureNetwork } from '../network';
import { isSegWit } from '../cat21-script/address-format';
import { buildInputScript } from '../cat21-script/build-input-script';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
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
 * Pure function. No I/O, no Angular. `walletType` is retained for
 * orchestration concerns but is NOT used for script construction.
 */
export interface PrepareBuyOfferBuyerInputArgs {
  /** Orchestration hint only — does NOT affect script construction. */
  walletType: KnownOrdinalWalletType;
  utxo: TxnOutput;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  isSimulation: boolean;
  network: Network;
}

export function prepareBuyOfferBuyerInput(args: PrepareBuyOfferBuyerInputArgs): Cat21OfferBuyerInput {
  void args.walletType;

  const scureNetwork = toScureNetwork(args.network);

  const { scriptData, tapInternalKey } = buildInputScript({
    paymentAddress: args.paymentAddress,
    paymentPublicKey: args.paymentPublicKey,
    isSimulation: args.isSimulation,
    network: scureNetwork,
  });

  const result: Cat21OfferBuyerInput = {
    txid: args.utxo.txid,
    vout: args.utxo.vout,
    value: args.utxo.value,
    scriptPubKey: scriptData.script,
  };

  if (scriptData.redeemScript) {
    result.redeemScript = scriptData.redeemScript;
  }
  if (tapInternalKey) {
    result.tapInternalKey = tapInternalKey;
  }

  if (!isSegWit(args.paymentAddress)) {
    if (args.isSimulation) {
      const dummyTx = getDummyLegacyTransaction(args.utxo, scureNetwork);
      result.txid = dummyTx.id;
      result.nonWitnessUtxo = hex.decode(dummyTx.hex);
    } else if (args.utxo.transactionHex) {
      result.nonWitnessUtxo = hex.decode(args.utxo.transactionHex);
    } else {
      throw new Error('Missing transaction hex for legacy UTXO input');
    }
  }

  return result;
}
