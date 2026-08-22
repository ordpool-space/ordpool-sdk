import { prepareCat21Input, PrepareCat21InputArgs } from '../cat21-script/prepare-cat21-input';
import {
  Cat21TransferCatInput,
  Cat21TransferFundingInput,
} from './cat21-transfer.types';

/**
 * Layer-2 input adapter for the CAT-21 transfer pipeline. Two semantic
 * entry points (the cat UTXO at input 0, the funding UTXOs at 1..N)
 * that both delegate to the shared `prepareCat21Input` — same prepared
 * shape, distinct names for reader intent.
 */
export type PrepareTransferInputArgs = PrepareCat21InputArgs;

export function prepareTransferCatInput(args: PrepareTransferInputArgs): Cat21TransferCatInput {
  return prepareCat21Input(args);
}

export function prepareTransferFundingInput(args: PrepareTransferInputArgs): Cat21TransferFundingInput {
  return prepareCat21Input(args);
}
