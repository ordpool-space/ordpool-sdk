import { hex } from '@scure/base';

import { Network, toScureNetwork } from '../network';
import { buildInputScript } from '../cat21-script/build-input-script';
import { isSegWit } from '../cat21-script/address-format';
import { getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
import { TxnOutput } from '../cat21-mint/cat21.service.types';

/**
 * Layer-2 input adapter for the CAT-21 inscribe pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the funding-input shape that
 * `buildInscribeCommitPsbt` consumes.
 *
 * Address-format-driven via `buildInputScript` — universal dispatch
 * across all wallet variants the SDK supports. Wallet identity is
 * irrelevant; only the payment address shape matters. Mirrors
 * `prepareMintInputForWallet` (the cat21 mint adapter) line-for-line.
 *
 * Pure function. No I/O, no Angular.
 */
export interface InscribeFundingInput {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: Uint8Array;
  /** Set on P2TR funding inputs (Unisat-Taproot, Xverse-Taproot, etc.). */
  tapInternalKey?: Uint8Array;
  /** Set on P2SH-wrapped funding (Xverse Nested SegWit, Unisat-NestedSegWit). */
  redeemScript?: Uint8Array;
  /** Set on legacy P2PKH funding — scure requires full prev-tx bytes. */
  nonWitnessUtxo?: Uint8Array;
}

export interface PrepareInscribeFundingInputArgs {
  utxo: TxnOutput;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  isSimulation: boolean;
  network: Network;
}

export function prepareInscribeFundingInput(
  args: PrepareInscribeFundingInputArgs
): InscribeFundingInput {
  const scureNetwork = toScureNetwork(args.network);

  const { scriptData, tapInternalKey } = buildInputScript({
    paymentAddress: args.paymentAddress,
    paymentPublicKey: args.paymentPublicKey,
    isSimulation: args.isSimulation,
    network: scureNetwork,
  });

  const result: InscribeFundingInput = {
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
    // Legacy P2PKH path. Scure refuses witnessUtxo on legacy inputs;
    // the full previous-tx bytes go via nonWitnessUtxo.
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
