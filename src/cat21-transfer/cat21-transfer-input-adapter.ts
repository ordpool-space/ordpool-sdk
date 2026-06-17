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
import {
  Cat21TransferCatInput,
  Cat21TransferFundingInput,
} from './cat21-transfer.types';

/**
 * Layer-2 input adapter for the CAT-21 transfer pipeline.
 *
 * Takes a raw UTXO (cat-bearing OR funding) plus the wallet's payment
 * details and produces a `Cat21TransferCatInput` / `Cat21TransferFundingInput`
 * with the right scriptPubKey + (optional) tapInternalKey / redeemScript /
 * nonWitnessUtxo. Same per-wallet matrix as the mint adapter — Leather,
 * CAT-21 wallet, Xverse, Unisat-SegWit/Taproot/Legacy all flow through
 * one function.
 *
 * `isSimulation = true` swaps the real pubkey for the SDK's well-known
 * dummy key — used during the two-pass fee simulation so vsize is
 * observable without exposing the user's key material.
 *
 * Pure function. No I/O, no Angular. Both the wallet-side autonomous
 * transfer flow AND a cat21.space-shaped consumer would call the same
 * adapter and feed the result into the same `buildCat21TransferPsbt`.
 */
export interface PrepareTransferInputArgs {
  walletType: KnownOrdinalWalletType;
  /** The UTXO to wrap — cat-bearing or funding, same per-wallet logic either way. */
  utxo: TxnOutput;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  isSimulation: boolean;
  network: Network;
}

export function prepareTransferCatInput(args: PrepareTransferInputArgs): Cat21TransferCatInput {
  return prepareInput(args);
}

export function prepareTransferFundingInput(args: PrepareTransferInputArgs): Cat21TransferFundingInput {
  return prepareInput(args);
}

function prepareInput(args: PrepareTransferInputArgs): Cat21TransferCatInput {
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

  const result: Cat21TransferCatInput = {
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
