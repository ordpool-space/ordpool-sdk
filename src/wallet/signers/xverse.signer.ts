import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { Observable } from 'rxjs';
import { signTransaction, SignTransactionResponse } from 'sats-connect';

import { toBitcoinNetworkType } from '../../network';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  WalletSigner,
} from '../wallet.service.types';


/**
 * Xverse — sats-connect v1 `signTransaction` (callback-style).
 *
 * Xverse signs and broadcasts atomically in one user dialog. The
 * `broadcast` callback from the input is ignored; sats-connect's
 * `broadcast: true` flag tells the wallet to push the tx itself.
 *
 * Migration to sats-connect v3 (`provider.request('signPsbt', ...)`)
 * is Phase 2 of the plan, a separate stream.
 */
export const xverseSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.xverse,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {

    const networkType = toBitcoinNetworkType(input.network);
    const psbtBase64 = base64.encode(input.psbtBytes);

    return new Observable<{ txId: string }>((observer) => {
      signTransaction({
        payload: {
          network: {
            type: networkType,
          },
          message: 'Sign Transaction (CAT-21 Mint)',
          psbtBase64,
          broadcast: true,
          inputsToSign: [
            {
              address: input.paymentAddress,
              signingIndexes: [0],
              sigHash: btc.SigHash.ALL,
            },
          ],
        },
        onFinish: (response: SignTransactionResponse) => {
          const txId = response.txId || '';
          observer.next({ txId });
          observer.complete();
        },
        onCancel: () => {
          observer.error(new Error('Request was cancelled'));
        },
      });
    });
  },
};
