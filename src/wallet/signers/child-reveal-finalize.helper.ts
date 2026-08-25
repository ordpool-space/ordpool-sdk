import * as btc from '@scure/btc-signer';
import { Observable, map } from 'rxjs';

import { extractWireTxFromPsbt } from '../psbt-extract';

/**
 * Shared tail for the child-inscription reveal, wallet-agnostic.
 *
 * The wallet signs ONLY input 0 (the parent, a P2TR key-path spend) on
 * the BARE wallet-facing PSBT — input 1 there has no envelope tap-leaf,
 * which some `signPsbt` implementations reject. This function takes the
 * wallet-signed bare PSBT, lifts input 0's Schnorr key-path signature,
 * carries it onto the FULL PSBT (whose input 1 carries the ephemeral
 * tapScriptSig + envelope leaf), finalizes BOTH inputs, and broadcasts
 * the wire tx.
 *
 * Input 0 is a P2TR key-path spend whose witness is exactly the 64/65-byte
 * Schnorr sig — read it from the raw `tapKeySig`, or (if the wallet
 * auto-finalized) the single element of the finalized witness. The FULL
 * PSBT is parsed with `allowUnknownInputs` because input 1's envelope
 * tap-leaf is a non-standard script scure won't recognize as owned.
 */
/**
 * Prepare the wallet-facing PSBT for an offer-ACCEPT where the seller wallet
 * signs ONLY its cat input 0. Some wallets' modern `signPsbt` (Xverse) hang
 * on a PSBT whose input is already signed by another party, and refuse a
 * Taproot key-path input that carries no `tapInternalKey`. Rebuild a bare
 * copy that mirrors the proven child-reveal shape:
 *   - input 0 (the seller's cat) gains its `tapInternalKey`, so the wallet
 *     recognises the Taproot key-path spend of its own ordinals key;
 *   - every other input is reduced to its `witnessUtxo` (the buyer's
 *     partial sig stripped), so nothing foreign is pre-signed.
 * Version, lockTime and every input's outpoint + sequence are copied
 * verbatim so the wallet's SIGHASH_ALL signature over input 0 stays valid
 * for the full tx. The signed input-0 key-path sig is then merged onto the
 * full buyer-signed PSBT via {@link mergeParentSigAndBroadcast}, and both
 * inputs finalize.
 */
export function prepareOfferAcceptWalletFacing(
  fullPsbtBytes: Uint8Array,
  sellerOrdinalsXOnly: Uint8Array,
): Uint8Array {
  const full = btc.Transaction.fromPSBT(fullPsbtBytes, { allowUnknownInputs: true });
  const bare = new btc.Transaction({
    version: full.version,
    lockTime: full.lockTime,
    allowUnknownInputs: true,
    allowLegacyWitnessUtxo: true,
  });
  for (let i = 0; i < full.inputsLength; i++) {
    const inp = full.getInput(i);
    const base = { txid: inp.txid, index: inp.index, sequence: inp.sequence, witnessUtxo: inp.witnessUtxo };
    bare.addInput(i === 0 ? { ...base, tapInternalKey: sellerOrdinalsXOnly } : base);
  }
  for (let i = 0; i < full.outputsLength; i++) {
    bare.addOutput(full.getOutput(i));
  }
  return bare.toPSBT(0);
}

export function mergeParentSigAndBroadcast(
  signedWalletFacing: Uint8Array,
  finalizePsbtBytes: Uint8Array,
  broadcast: (wireTxHex: string) => Observable<string>,
): Observable<{ txId: string }> {
  const walletSigned = btc.Transaction.fromPSBT(signedWalletFacing);
  const in0 = walletSigned.getInput(0);
  const keySig = in0.tapKeySig ?? in0.finalScriptWitness?.[0];
  if (!keySig) {
    throw new Error('child reveal: wallet did not sign the parent input (index 0)');
  }
  const full = btc.Transaction.fromPSBT(finalizePsbtBytes, { allowUnknownInputs: true });
  full.updateInput(0, { tapKeySig: keySig }, true);
  const wireHex = extractWireTxFromPsbt(full.toPSBT(0));
  return broadcast(wireHex).pipe(map((txId) => ({ txId })));
}
