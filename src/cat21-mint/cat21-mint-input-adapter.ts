import { hex } from '@scure/base';

import { Network, toScureNetwork } from '../network';
import { buildInputScript } from '../cat21-script/build-input-script';
import { isSegWit } from '../cat21-script/address-format';
import { getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
import { TxnOutput } from './cat21.service.types';
import { Cat21MintFundingInput } from './cat21-mint.helper';

/**
 * Layer-2 input adapter for the CAT-21 mint pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the full `Cat21MintFundingInput` shape that
 * `buildCat21MintPsbt` consumes.
 *
 * Address-format-driven via `buildInputScript`. The wallet identity
 * is irrelevant — only the payment address shape matters.
 *
 * Pure function. No I/O, no Angular.
 */
export function prepareMintInputForWallet(
  paymentOutput: TxnOutput,
  paymentPublicKey: Uint8Array,
  paymentAddress: string,
  isSimulation: boolean,
  network: Network,
): Cat21MintFundingInput {
  const scureNetwork = toScureNetwork(network);

  const { scriptData, tapInternalKey } = buildInputScript({
    paymentAddress,
    paymentPublicKey,
    isSimulation,
    network: scureNetwork,
  });

  const result: Cat21MintFundingInput = {
    txid: paymentOutput.txid,
    vout: paymentOutput.vout,
    value: paymentOutput.value,
    scriptPubKey: scriptData.script,
  };

  if (scriptData.redeemScript) {
    result.redeemScript = scriptData.redeemScript;
  }

  if (tapInternalKey) {
    result.tapInternalKey = tapInternalKey;
  }

  if (!isSegWit(paymentAddress)) {
    // Legacy P2PKH path. Scure refuses witnessUtxo on legacy inputs;
    // the full previous-tx bytes go via nonWitnessUtxo.
    if (isSimulation) {
      const dummyTx = getDummyLegacyTransaction(paymentOutput, scureNetwork);
      result.txid = dummyTx.id;
      result.nonWitnessUtxo = hex.decode(dummyTx.hex);
    } else if (paymentOutput.transactionHex) {
      result.nonWitnessUtxo = hex.decode(paymentOutput.transactionHex);
    } else {
      throw new Error('Missing transaction hex for legacy UTXO input');
    }
  }

  return result;
}
