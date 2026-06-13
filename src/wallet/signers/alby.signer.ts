import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface WebBtcApi {
  enable?(): Promise<void>;
  signPsbt(psbt: string, opts?: { sighashTypes?: number[] }): Promise<{ signed: string }>;
}

interface AlbyApi {
  enable(): Promise<void>;
  webbtc: WebBtcApi;
}


/**
 * Alby — `window.alby.webbtc.signPsbt(psbtHex, { sighashTypes: [1] })`.
 *
 * Alby's BTC sub-provider sits at `alby.webbtc` (verified iter 99
 * against background.bundle.js v3.14.2). signPsbt accepts the PSBT
 * as hex and returns `{ signed: <wire-tx-hex> }` — the wire-format
 * raw transaction hex, already finalised by Alby's internal
 * bitcoinjs-lib `extractTransaction().toHex()`. NOT a signed PSBT.
 * We broadcast that wire-tx directly.
 *
 * **Two Alby quirks every caller must respect** (verified iter 108
 * against background.bundle.js):
 *
 * 1. **Alby signs EVERY input in the PSBT, no opt-in.** The
 *    background-script's `bitcoin.signPsbt` does
 *    `psbt.data.inputs.forEach(i => psbt.signTaprootInput(i, key))`
 *    with the user's single key at `m/86'/1'/0'/0/0`. There is no
 *    `signInputs` / `toSignInputs` knob — those args are dropped on
 *    the floor. Caller MUST only hand Alby a PSBT whose inputs are
 *    all the user's own UTXOs. A multi-party / collab-swap PSBT
 *    will either throw on the first non-matching input or blindly
 *    sign with the user's key. For our cat21 mint (1 input, owner's
 *    own UTXO, owner-pays-fee) this is fine.
 *
 * 2. **The Taproot input MUST be built with SIGHASH_DEFAULT.**
 *    Alby's signer doesn't pass `allowedSighashTypes` to
 *    bitcoinjs-lib's `signTaprootInput`, so bitcoinjs's default
 *    whitelist rejects anything other than SIGHASH_DEFAULT (0).
 *    PSBTs built with `sighashType: SIGHASH_ALL` get
 *    `Sighash type is not allowed. Sighash type: SIGHASH_ALL`.
 *    For Taproot key-path the two encode identically on the wire
 *    (both commit to all outputs), so SIGHASH_DEFAULT is the
 *    correct + only working choice.
 *
 * Targets the Alby Browser Extension. Alby Go (mobile) doesn't
 * inject in-page providers — it uses NWC deeplinks, a completely
 * different integration model that this signer doesn't cover.
 */
export const albySigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.alby,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const alby = (window as unknown as { alby: AlbyApi }).alby;

    const p = (async () => {
      await alby.enable();
      if (alby.webbtc.enable) await alby.webbtc.enable();
      // sighashTypes:[1] = SIGHASH_ALL whitelist required by Alby's
      // bitcoinjs-lib (its default whitelist only allows SIGHASH_
      // DEFAULT — see iter 104). Our PSBTs target Taproot key-path
      // and the wire encoding is identical, so the whitelist just
      // satisfies Alby's policy check.
      const { signed } = await alby.webbtc.signPsbt(psbtHex, { sighashTypes: [1] });
      return signed;
    })();

    return from(p).pipe(
      // Alby returns wire-tx hex (already finalised), not a signed
      // PSBT. Broadcast the hex directly — no extract step.
      switchMap(txHex => input.broadcast(txHex)),
      map(txId => ({ txId })),
    );
  },
};
