import { hex } from '@scure/base';
import { from, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';
import { resolveSigningTargets } from './signing-targets.helper';


interface OkxToSignInput {
  index: number;
  address?: string;
  sighashTypes?: number[];
}

interface OkxBtcRpc {
  signPsbt(
    psbtHex: string,
    options?: { autoFinalized?: boolean; from?: string; toSignInputs?: OkxToSignInput[] }
  ): Promise<string>;
}


/**
 * OKX — `window.okxwallet.bitcoin.signPsbt(hex, {autoFinalized:
 * false})`.
 *
 * OKX is a multi-chain wallet; the BTC sub-provider lives at
 * `window.okxwallet.bitcoin`. Its signPsbt accepts the same
 * `autoFinalized` option as Unisat (verified by grepping
 * inpage.js v4.1.0). Per the SDK-wide "WE broadcast" convention,
 * we skip OKX's `sendPsbt` and broadcast via the caller-supplied
 * `input.broadcast` callback.
 *
 * Multi-input signing: OKX follows the Unisat-derived
 * `toSignInputs` convention. Same mapping as the unisat signer.
 */
export const okxSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.okx,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;
    return from(okxBtc.signPsbt(psbtHex, { autoFinalized: false })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;

    const targets = resolveSigningTargets(input);
    const toSignInputs: OkxToSignInput[] = [];
    for (const t of targets) {
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
      }
    }

    return from(okxBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },
};
