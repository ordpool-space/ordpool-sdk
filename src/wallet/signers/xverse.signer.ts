import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { Observable, switchMap } from 'rxjs';
import { signTransaction } from 'sats-connect';

import { toBitcoinNetworkType } from '../../network';
import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


/**
 * Xverse — sats-connect v4 `signTransaction` (callback-style).
 *
 * Per the SDK-wide "WE broadcast" convention (see
 * `/Work/ordpool/WALLETS.md`): we ask Xverse to sign only
 * (`broadcast: false`), extract the wire-format tx ourselves, and
 * hand it to `input.broadcast(rawTxHex)`. The caller's broadcast
 * callback decides the endpoint — electrs, mempool.space,
 * api.ordpool.space, Mara non-standard-relay, etc.
 *
 * Migration to sats-connect v3+ `provider.request('signPsbt', ...)`
 * is a separate stream.
 */
export const xverseSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.xverse,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {

    // Cast at the sats-connect boundary — see xverse.connector.ts
    // for the full rationale (network.ts deliberately doesn't import
    // BitcoinNetworkType from sats-connect to keep axios out of the
    // /core bundle; the runtime strings agree exactly).
    const networkType = toBitcoinNetworkType(input.network) as unknown as Parameters<typeof signTransaction>[0]['payload']['network']['type'];
    const psbtBase64 = base64.encode(input.psbtBytes);

    const signedPsbt$ = new Observable<string>((observer) => {
      signTransaction({
        payload: {
          network: { type: networkType },
          message: 'Sign Transaction (CAT-21 Mint)',
          psbtBase64,
          broadcast: false, // we broadcast via input.broadcast(...)
          inputsToSign: [
            {
              address: input.paymentAddress,
              signingIndexes: [0],
              sigHash: btc.SigHash.ALL,
            },
          ],
        },
        onFinish: (response) => {
          const signed = (response as { psbtBase64?: string }).psbtBase64;
          if (!signed) {
            observer.error(new Error('Xverse signTransaction returned without psbtBase64'));
            return;
          }
          observer.next(signed);
          observer.complete();
        },
        onCancel: () => {
          observer.error(new Error('Request was cancelled'));
        },
      });
    });

    return signedPsbt$.pipe(
      switchMap(signedPsbtBase64 => broadcastSignedPsbt(input, base64.decode(signedPsbtBase64))),
    );
  },
};
