import * as btc from '@scure/btc-signer';
import { map, Observable } from 'rxjs';

import { SignAndBroadcastInput, SignMultiInputAndBroadcastInput } from './wallet.service.types';

/**
 * The two signer-input shapes share `broadcast` — that's all the
 * post-sign step needs. Typing the helper against just `broadcast`
 * keeps it usable from both call sites without an unsound union
 * widening anywhere.
 */
type BroadcastingInput = Pick<SignAndBroadcastInput | SignMultiInputAndBroadcastInput, 'broadcast'>;

/**
 * Finalize a signed PSBT (if needed) and extract the wire-format
 * raw transaction hex.
 *
 * Used by every wallet signer in `src/wallet/signers/` and by the
 * Pipeline B harness in `e2e/playwright/fixtures/`. Encodes the
 * SDK-wide "WE finalize, WE broadcast" convention (see
 * `/Work/ordpool/WALLETS.md`):
 *
 *  1. Wallets sign and hand back a PSBT (preferably with partial
 *     sigs, where the wallet API exposes a "don't finalize" option).
 *  2. `@scure/btc-signer.finalize()` combines partial sigs into
 *     `finalScriptWitness`. Some wallets always finalize themselves
 *     (Leather v6.x has no opt-out, Unisat with `autoFinalized:true`)
 *     — finalize() throws "Not enough partial sign" in that case;
 *     safe to ignore because the wallet's pre-populated witness is
 *     already in place. Re-throw anything else.
 *  3. `extract()` produces the wire-format bytes; we serialise to hex.
 */
export function extractWireTxFromPsbt(signedPsbtBytes: Uint8Array): string {
  const tx = btc.Transaction.fromPSBT(signedPsbtBytes);
  try {
    tx.finalize();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Two failure modes look the same to scure ("Not enough partial
    // sign") but mean opposite things:
    //   (A) Some wallets (Leather v6.x, Unisat autoFinalized:true)
    //       return a PSBT where every input already carries a
    //       `finalScriptWitness`. scure throws because it can't
    //       find partialSig fields, but the wire tx is complete.
    //   (B) A different signing path stripped inputs 1..N sigs
    //       (some wallets don't preserve inputs they didn't sign).
    //       scure throws for the same reason, but tx.hex would have
    //       empty witnesses on those inputs — broadcast lands in
    //       mempool as `mandatory-script-verify-flag-failed`.
    //
    // Distinguish by checking which inputs are actually missing their
    // finalized script. A legacy (P2PKH) input carries a
    // `finalScriptSig` and NO witness; a segwit input carries a
    // `finalScriptWitness`. An input is only truly missing when it has
    // neither. If none are missing (A), swallow. If any are (B),
    // re-throw with scure's message plus the input indexes so the
    // caller can surface something actionable ("your wallet dropped
    // signatures on input N") instead of a downstream script-verify
    // failure that looks like our own bug.
    const missing: number[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      const hasWitness = !!input.finalScriptWitness && input.finalScriptWitness.length > 0;
      const hasScriptSig = !!input.finalScriptSig && input.finalScriptSig.length > 0;
      if (!hasWitness && !hasScriptSig) {
        missing.push(i);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `PSBT finalize failed on input(s) ${missing.join(', ')} of ${tx.inputsLength}: ${detail}`,
      );
    }
    // All inputs have a witness — the wallet pre-finalized. Ignore
    // scure's throw and proceed with the wire tx.
  }
  return tx.hex;
}

/**
 * Final 3 steps of every wallet signer's `signAndBroadcast`:
 * extract wire-tx hex from the wallet's signed PSBT, hand it to
 * the caller-supplied broadcast callback, wrap the resulting
 * txid in the `{ txId }` shape.
 *
 * Pins the "WE broadcast" convention: the broadcast endpoint is
 * the SDK's call, not the wallet's vendor backend. All three
 * production signers + the Pipeline B harness route through here.
 */
export function broadcastSignedPsbt(
  input: BroadcastingInput,
  signedPsbtBytes: Uint8Array,
): Observable<{ txId: string }> {
  const txHex = extractWireTxFromPsbt(signedPsbtBytes);
  return input.broadcast(txHex).pipe(map(txId => ({ txId })));
}
