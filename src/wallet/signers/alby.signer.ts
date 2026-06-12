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
