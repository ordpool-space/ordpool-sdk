import * as btc from '@scure/btc-signer';

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
 *  3. `extract()` produces the wire-format bytes; we serialise to hex
 *     for `POST /tx` broadcast.
 *
 * Returns a raw tx hex string suitable for handing to electrs /
 * mempool.space / api.ordpool.space / any custom broadcast endpoint.
 */
export function extractWireTxFromPsbt(signedPsbtBytes: Uint8Array): string {
  const tx = btc.Transaction.fromPSBT(signedPsbtBytes);
  try {
    tx.finalize();
  } catch (e) {
    if (!/Not enough partial sign/i.test((e as Error).message)) throw e;
  }
  return tx.hex;
}
