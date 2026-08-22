import { prepareCat21Input } from '../cat21-script/prepare-cat21-input';
import { Network } from '../network';
import { TxnOutput } from './cat21.service.types';
import { Cat21MintFundingInput } from './cat21-mint.helper';

/**
 * Layer-2 input adapter for the CAT-21 mint pipeline. Thin,
 * positional-args wrapper over the shared `prepareCat21Input`; the
 * mint / transfer / offer / inscribe adapters all delegate to that one
 * body so the wire-format logic (taproot / P2SH / legacy dispatch)
 * lives in a single place.
 */
export function prepareMintInputForWallet(
  paymentOutput: TxnOutput,
  paymentPublicKey: Uint8Array,
  paymentAddress: string,
  isSimulation: boolean,
  network: Network,
): Cat21MintFundingInput {
  return prepareCat21Input({
    utxo: paymentOutput,
    paymentPublicKey,
    paymentAddress,
    isSimulation,
    network,
  });
}
