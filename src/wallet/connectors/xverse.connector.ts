import { Observable } from 'rxjs';
import { AddressPurpose, getAddress } from 'sats-connect';

import { Network, toBitcoinNetworkType } from '../../network';
import {
  isXverseInstalled,
  parseXverseAddressResponse,
} from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
  XverseAddressResponse,
} from '../wallet.service.types';


/**
 * Xverse — sats-connect v1 transport.
 *
 * Namespace: `window.XverseProviders.BitcoinProvider`. We invoke
 * indirectly via the `getAddress` helper from `sats-connect`, which
 * walks `window.btc_providers[]` (v3 registry) but falls back to
 * `window.XverseProviders.BitcoinProvider` for the v1 era.
 *
 * The v3 RPC bump (`provider.request(method, params)`) lands in
 * Phase 2 of the wallet-roster plan; today's code is callback-style.
 */
export const xverseConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.xverse,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.xverse],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isXverseInstalled(win);
  },

  connect(network: Network): Observable<WalletInfo> {
    return new Observable<WalletInfo>((observer) => {
      getAddress({
        payload: {
          purposes: [AddressPurpose.Ordinals, AddressPurpose.Payment],
          message: 'Please share your address for receiving Ordinals and payments.',
          network: {
            // sats-connect's BitcoinNetworkType is structurally identical
            // to ours (the same wire-protocol strings), but TS 5.7+ treats
            // them as distinct types because they're declared in different
            // modules. Our `network.ts` deliberately doesn't import from
            // sats-connect (it would drag axios into the /core bundle); the
            // runtime strings agree exactly. Cast at the boundary.
            type: toBitcoinNetworkType(network) as unknown as Parameters<typeof getAddress>[0]['payload']['network']['type'],
          },
        },
        onFinish: (response) => {
          try {
            observer.next(parseXverseAddressResponse(response as XverseAddressResponse));
            observer.complete();
          } catch (error) {
            observer.error(error);
          }
        },
        onCancel: () => {
          observer.error(new Error('Request was cancelled'));
        },
      });
    });
  },
};
