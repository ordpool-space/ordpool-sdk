import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { getDummyKeypair, getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
import { Network, toScureNetwork } from '../network';
import { getAddressFormat, isSegWit, toXOnly } from '../cat21-script/address-format';
import {
  createInputScriptForLeather,
  createInputScriptForUnisat,
  createInputScriptForXverse,
} from '../cat21-script/per-wallet-scripts';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { Cat21OfferBuyerInput } from './cat21-offer.types';

/**
 * Layer-2 input adapter for the BUYER side of the CAT-21 buy-offer
 * flow.
 *
 * The buyer-initiated offer PSBT structurally has:
 *   - Input 0:  seller's cat UTXO (unsigned, the buyer references it
 *               by outpoint + scriptPubKey + value). The SELLER side
 *               doesn't go through this adapter — the buyer just
 *               needs the seller's outpoint + scriptPubKey, which
 *               they learn out-of-band (marketplace listing, ord
 *               inscription lookup, etc.).
 *   - Inputs 1..N: buyer's funding UTXOs. THIS adapter prepares
 *               those, applying the per-wallet matrix the same way
 *               the mint / transfer adapters do.
 *
 * The output shape carries `tapInternalKey` / `redeemScript` /
 * `nonWitnessUtxo` as needed so the buyer can sign with their wallet
 * regardless of address shape (Leather P2WPKH, Xverse P2SH-P2WPKH,
 * Unisat anything, CAT-21 wallet P2WPKH).
 *
 * `isSimulation = true` swaps in the dummy keypair so vsize is
 * observable during the two-pass fee simulation without exposing the
 * buyer's key material.
 *
 * Pure function. No I/O, no Angular.
 */
export interface PrepareBuyOfferBuyerInputArgs {
  walletType: KnownOrdinalWalletType;
  /** One of the buyer's funding UTXOs. */
  utxo: TxnOutput;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  isSimulation: boolean;
  network: Network;
}

export function prepareBuyOfferBuyerInput(args: PrepareBuyOfferBuyerInputArgs): Cat21OfferBuyerInput {
  const scureNetwork = toScureNetwork(args.network);

  let paymentPublicKeyToUse = args.paymentPublicKey;
  if (args.isSimulation) {
    paymentPublicKeyToUse = getDummyKeypair(scureNetwork).dummyPublicKey;
  }

  let scriptData: btc.P2Ret | btc.P2TROut;
  let tapInternalKey: Uint8Array | undefined;

  switch (args.walletType) {
    case KnownOrdinalWalletType.leather:
    case KnownOrdinalWalletType.cat21wallet: {
      scriptData = createInputScriptForLeather(paymentPublicKeyToUse, scureNetwork);
      break;
    }
    case KnownOrdinalWalletType.xverse: {
      scriptData = createInputScriptForXverse(args.paymentAddress, paymentPublicKeyToUse, scureNetwork);
      break;
    }
    case KnownOrdinalWalletType.unisat: {
      if (getAddressFormat(args.paymentAddress) === 'P2TR') {
        if (args.isSimulation) {
          paymentPublicKeyToUse = getDummyKeypair(scureNetwork).xOnlyDummyPublicKey;
        } else {
          paymentPublicKeyToUse = toXOnly(args.paymentPublicKey);
        }
        tapInternalKey = paymentPublicKeyToUse;
      }
      scriptData = createInputScriptForUnisat(args.paymentAddress, paymentPublicKeyToUse, scureNetwork);
      break;
    }
    default:
      throw new Error('Unknown wallet');
  }

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
    // Legacy P2PKH path. Scure refuses witnessUtxo for legacy inputs.
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
