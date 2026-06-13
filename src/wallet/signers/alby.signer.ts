import { hex } from '@scure/base';
import { from, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


interface AlbyBtcRpc {
  signPsbt(psbtHex: string): Promise<{ signed: string }>;
}

interface AlbyApi {
  enable(): Promise<void>;
  getBitcoin(): AlbyBtcRpc;
}


/**
 * Alby — `window.alby.getBitcoin().signPsbt(psbtHex)`.
 *
 * Alby's BTC sub-provider implements three WebBTC methods
 * (`getInfo`, `signPsbt`, `getAddress`). signPsbt accepts the PSBT
 * as hex and returns `{ signed: <signed-psbt-hex> }`. Schema
 * verified by grepping background.bundle.js v3.14.2:
 *
 *   supports: ["bitcoin"], methods: ["getInfo","signPsbt","getAddress"]
 *
 * **Runtime caveat:** the call delegates to whichever backend the
 * user has connected to their Alby account — Alby Hub, Mutiny, or
 * another on-chain-capable wallet. Users with only a custodial
 * Lightning account (no on-chain backend) will get a runtime error
 * when signPsbt is invoked. We don't gate on this at the SDK level
 * because there's no static signal for it; the error propagates
 * to the caller. The connector reports `signingSupported: true`
 * because the API is technically present; the runtime backend
 * check is the user's responsibility.
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
      const btc = alby.getBitcoin();
      const { signed } = await btc.signPsbt(psbtHex);
      return signed;
    })();

    return from(p).pipe(
      switchMap(signedHex => broadcastSignedPsbt(input, hex.decode(signedHex))),
    );
  },
};
