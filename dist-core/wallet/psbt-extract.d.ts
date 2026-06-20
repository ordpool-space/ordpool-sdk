import { Observable } from 'rxjs';
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
export declare function extractWireTxFromPsbt(signedPsbtBytes: Uint8Array): string;
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
export declare function broadcastSignedPsbt(input: BroadcastingInput, signedPsbtBytes: Uint8Array): Observable<{
    txId: string;
}>;
export {};
//# sourceMappingURL=psbt-extract.d.ts.map