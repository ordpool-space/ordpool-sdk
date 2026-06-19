import { Observable } from 'rxjs';
import { addListener, AddressPurpose, getAddress } from 'sats-connect';

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

  /**
   * sats-connect v4+ exposes three event types: `accountChange`,
   * `networkChange`, `disconnect`. All three indicate "the cached
   * WalletInfo is no longer authoritative" — fan into one callback.
   *
   * `addListener` returns an unsubscribe `() => void` directly per
   * sats-connect's API. If the wallet provider is older than v4 and
   * doesn't expose the listener API, sats-connect throws — we catch
   * and return a no-op so the consumer's lifecycle code stays clean.
   */
  onAccountChange(handler: () => void): () => void {
    const unsubscribes: Array<() => void> = [];
    try {
      unsubscribes.push(addListener('accountChange', () => handler()));
      unsubscribes.push(addListener('networkChange', () => handler()));
      unsubscribes.push(addListener('disconnect', () => handler()));
    } catch {
      // Older sats-connect or pre-v4 wallet build: no event surface.
      // Consumers should re-call connect() at sign-time as the fallback.
      return () => undefined;
    }
    return () => unsubscribes.forEach(u => u());
  },
};
