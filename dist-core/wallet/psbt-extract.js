import * as btc from '@scure/btc-signer';
import { map } from 'rxjs';
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
export function extractWireTxFromPsbt(signedPsbtBytes) {
    const tx = btc.Transaction.fromPSBT(signedPsbtBytes);
    try {
        tx.finalize();
    }
    catch (e) {
        if (!/Not enough partial sign/i.test(e.message))
            throw e;
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
export function broadcastSignedPsbt(input, signedPsbtBytes) {
    const txHex = extractWireTxFromPsbt(signedPsbtBytes);
    return input.broadcast(txHex).pipe(map(txId => ({ txId })));
}
//# sourceMappingURL=psbt-extract.js.map