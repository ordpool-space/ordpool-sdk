import {
  Cat21PreparedInput,
  PrepareCat21InputArgs,
  prepareCat21Input,
} from '../cat21-script/prepare-cat21-input';

/**
 * Layer-2 input adapter for the CAT-21 inscribe pipeline. Thin wrapper
 * over the shared `prepareCat21Input` (same body the mint / transfer /
 * offer adapters delegate to). Turns a raw funding UTXO + the wallet's
 * payment details into the funding-input shape `buildInscribeCommitPsbt`
 * consumes.
 */
export type InscribeFundingInput = Cat21PreparedInput;

export type PrepareInscribeFundingInputArgs = PrepareCat21InputArgs;

export function prepareInscribeFundingInput(
  args: PrepareInscribeFundingInputArgs,
): InscribeFundingInput {
  return prepareCat21Input(args);
}
