import { base64 } from '@scure/base';
import { from, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';
import { resolveSigningTargets } from './signing-targets.helper';


interface OylInputToSign {
  address: string;
  signingIndexes: number[];
  sigHash?: number;
}

interface OylRpc {
  signPsbt(args: { psbtBase64: string; inputsToSign: OylInputToSign[] }): Promise<{ signedPsbt: string }>;
}


/**
 * Oyl — `window.oyl.signPsbt({psbtBase64, inputsToSign})`.
 *
 * Oyl exposes a single `window.oyl` provider whose methods route
 * via its relay-based messaging shim to the extension background.
 * Schema verified by grepping oylConnectProvider.baac0163.js +
 * static/background/index.js v1.17.1:
 *
 *   signPsbt({psbtBase64, inputsToSign}) → {signedPsbt: string}
 *
 * `signedPsbt` is returned as base64. Oyl also exposes `pushPsbt`
 * (skipped per the SDK-wide "WE broadcast" convention).
 *
 * The `inputsToSign` shape mirrors sats-connect's
 * `[{address, signingIndexes, sigHash}]`. SIGHASH_ALL = 0x01.
 */
export const oylSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.oyl,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtBase64 = base64.encode(input.psbtBytes);
    const oyl = (window as unknown as { oyl: OylRpc }).oyl;
    const signPromise = oyl.signPsbt({
      psbtBase64,
      inputsToSign: [{ address: input.paymentAddress, signingIndexes: [0], sigHash: 0x01 }],
    });
    return from(signPromise).pipe(
      switchMap(response => broadcastSignedPsbt(input, base64.decode(response.signedPsbt))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const psbtBase64 = base64.encode(input.psbtBytes);
    const oyl = (window as unknown as { oyl: OylRpc }).oyl;
    const targets = resolveSigningTargets(input);
    const inputsToSign = targets.map((t) => ({
      address: t.address,
      signingIndexes: t.indexes,
      sigHash: t.sigHash,
    }));
    const signPromise = oyl.signPsbt({ psbtBase64, inputsToSign });
    return from(signPromise).pipe(
      switchMap(response => broadcastSignedPsbt(input, base64.decode(response.signedPsbt))),
    );
  },
};
