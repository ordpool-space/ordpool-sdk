import * as btc from '@scure/btc-signer';
import { nonAllSighashFlag } from './cat21-offer.helper.js';

/**
 * Finalise a buy-offer's buyer inputs (1..N) after the buyer's wallet signed
 * them, the shape `ord wallet offer create` hands out: ord's `wallet offer
 * accept` counts a buyer input as signed only by its final scriptSig or
 * witness, and finalising clears the per-input fields (partialSig,
 * sighashType) that ord refuses. Input 0, the seller's cat, stays unsigned.
 *
 * Throws when a buyer signature commits under anything but SIGHASH_ALL: a
 * published offer is spendable by whoever holds it, so a weaker signature
 * would let anyone re-point the buyer's coins.
 */
export function finalizeOfferBuyerInputs(psbt: Uint8Array): Uint8Array {
  const tx = btc.Transaction.fromPSBT(psbt, { allowUnknownInputs: true });
  for (let i = 1; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const violation = nonAllSighashFlag(input);
    if (violation) {
      throw new Error(`finalizeOfferBuyerInputs: buyer input ${i} ${violation}`);
    }
    const finalised = (input.finalScriptWitness?.length ?? 0) > 0 || (input.finalScriptSig?.length ?? 0) > 0;
    if (!finalised) {
      tx.finalizeIdx(i);
    }
  }
  return tx.toPSBT();
}
