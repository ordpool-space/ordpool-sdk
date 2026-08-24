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

/**
 * Copy the ephemeral-commit input's `tapInternalKey` from the full reveal
 * PSBT onto the wallet-facing input 1. OKX's dApp signPsbt approval
 * preview iterates every input and requires each Taproot input to carry a
 * public key (per OKX's provider docs: "add a public key for every input
 * of the psbt if the input uses a Taproot address"). The bare wallet-
 * facing input 1 (witnessUtxo only) carries none, so OKX's preview throws
 * before rendering the popup. Attaching the (ephemeral) internal key lets
 * the preview render the input; OKX still signs only input 0 (its
 * toSignInputs entry) and leaves input 1 untouched.
 */
export function addCommitTaprootKeyToWalletFacing(
  walletFacingBytes: Uint8Array,
  fullPsbtBytes: Uint8Array,
): Uint8Array {
  const wf = btc.Transaction.fromPSBT(walletFacingBytes, { allowUnknownInputs: true });
  const full = btc.Transaction.fromPSBT(fullPsbtBytes, { allowUnknownInputs: true });
  const commitKey = full.getInput(1).tapInternalKey;
  if (commitKey) {
    wf.updateInput(1, { tapInternalKey: commitKey }, true);
  }
  return wf.toPSBT(0);
}

/**
 * `signChildRevealParentInputs` for OKX: present the wallet-facing reveal
 * PSBT with the commit input carrying its Taproot internal key (see
 * `addCommitTaprootKeyToWalletFacing`), sign input 0 only, then merge onto
 * the full reveal PSBT and broadcast.
 */
export function signChildRevealShowingCommitKey(
  signPsbtOnly: (input: SignPsbtOnlyInput) => Observable<Uint8Array>,
  input: SignChildRevealParentInputsArgs,
): Observable<{ txId: string }> {
  const walletFacing = addCommitTaprootKeyToWalletFacing(input.psbtBytes, input.finalizePsbtBytes);
  return signPsbtOnly({
    psbtBytes: walletFacing,
    signingMap: [{ address: input.ordinalsAddress, indexes: [0], publicKey: input.ordinalsPublicKey }],
    network: input.network,
    promptForSignedPsbt: input.promptForSignedPsbt,
  }).pipe(
    switchMap((signed) => mergeParentSigAndBroadcast(signed, input.finalizePsbtBytes, input.broadcast)),
  );
}
