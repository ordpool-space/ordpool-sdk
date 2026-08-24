import * as btc from '@scure/btc-signer';
import { Observable, map, switchMap } from 'rxjs';

import { extractWireTxFromPsbt } from '../psbt-extract';
import {
  SignChildRevealParentInputsArgs,
  SignPsbtOnlyInput,
} from '../wallet.service.types';

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
export function mergeParentSigAndBroadcast(
  signedWalletFacing: Uint8Array,
  finalizePsbtBytes: Uint8Array,
  broadcast: (wireTxHex: string) => Observable<string>,
): Observable<{ txId: string }> {
  const walletSigned = btc.Transaction.fromPSBT(signedWalletFacing, { allowUnknownInputs: true });
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

/**
 * Wallet-facing reveal PSBT with the ephemeral-commit input (index 1)
 * presented as FINALIZED, for address-filtering wallets (Unisat / OKX /
 * Wizz) whose pre-sign approval UI runs a decode that can't attribute a
 * bare, unowned input on regtest and leaves the Sign button disabled. A
 * finalized input is complete, so the wallet only needs to sign input 0.
 *
 * Input 1's finalScriptWitness is built from the ephemeral tapScriptSig +
 * envelope leaf already carried on the full reveal PSBT. Input 0 stays
 * unsigned. Input 0's Taproot key-path sighash commits to input 1's
 * prevout / amount / scriptPubKey (identical here to the full PSBT), not
 * to input 1's witness, so the signature the wallet returns is valid when
 * merged onto the full PSBT.
 */
export function finalizeForeignCommitInput(fullPsbtBytes: Uint8Array): Uint8Array {
  const tx = btc.Transaction.fromPSBT(fullPsbtBytes, { allowUnknownInputs: true });
  tx.finalizeIdx(1);
  return tx.toPSBT(0);
}

/**
 * `signChildRevealParentInputs` for address-filtering wallets: sign input
 * 0 on the finalized-foreign-input wallet-facing PSBT (see
 * `finalizeForeignCommitInput`), then merge input 0's key-path signature
 * onto the full reveal PSBT and broadcast.
 */
export function signChildRevealViaFinalizedForeignInput(
  signPsbtOnly: (input: SignPsbtOnlyInput) => Observable<Uint8Array>,
  input: SignChildRevealParentInputsArgs,
): Observable<{ txId: string }> {
  const walletFacing = finalizeForeignCommitInput(input.finalizePsbtBytes);
  return signPsbtOnly({
    psbtBytes: walletFacing,
    signingMap: [{ address: input.ordinalsAddress, indexes: [0], publicKey: input.ordinalsPublicKey }],
    network: input.network,
    promptForSignedPsbt: input.promptForSignedPsbt,
  }).pipe(
    switchMap((signed) => mergeParentSigAndBroadcast(signed, input.finalizePsbtBytes, input.broadcast)),
  );
}
