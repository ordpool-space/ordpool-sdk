import { hex } from '@scure/base';

import { getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
import { Network, toScureNetwork } from '../network';
import { isSegWit } from '../cat21-script/address-format';
import { buildInputScript } from '../cat21-script/build-input-script';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  Cat21TransferCatInput,
  Cat21TransferFundingInput,
} from './cat21-transfer.types';

/**
 * Layer-2 input adapter for the CAT-21 transfer pipeline.
 *
 * Address-format-driven: dispatches via `buildInputScript`. The
 * `walletType` argument is retained for orchestration concerns the
 * SDK still needs (sequence-number rule etc.) but is NOT used to
 * select script type.
 *
 * Net effect: every wallet — including those the SDK previously
 * threw 'Unknown wallet' on — produces a correct transfer input.
 *
 * Pure function. No I/O, no Angular.
 */
export interface PrepareTransferInputArgs {
  /** Orchestration hint only — does NOT affect script construction. */
  walletType: KnownOrdinalWalletType;
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
  void args.walletType;

  const scureNetwork = toScureNetwork(args.network);

  const { scriptData, tapInternalKey } = buildInputScript({
    paymentAddress: args.paymentAddress,
    paymentPublicKey: args.paymentPublicKey,
    isSimulation: args.isSimulation,
    network: scureNetwork,
  });

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
