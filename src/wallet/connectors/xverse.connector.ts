import { from, Observable } from 'rxjs';
import Wallet, { addListener, AddressPurpose, BitcoinNetworkType } from 'sats-connect';

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
 * Xverse — sats-connect v4 modern RPC (`Wallet.request(method, params)`).
 *
 * `wallet_connect` establishes the session ON the requested network and
 * returns the ordinals + payment addresses in one call. Setting the
 * session network here is what makes the later `signPsbt` (in
 * `xverse.signer.ts`) sign against the right network — the modern
 * `signPsbt` has no per-request network arg (unlike the deprecated
 * `signTransaction` it replaced); it uses the session network established
 * at connect.
 */
export const xverseConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.xverse,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.xverse],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isXverseInstalled(win);
  },

  connect(network: Network): Observable<WalletInfo> {
    return from(
      Wallet.request('wallet_connect', {
        addresses: [AddressPurpose.Ordinals, AddressPurpose.Payment],
        message: 'Please share your address for receiving Ordinals and payments.',
        // Our BitcoinNetworkType is structurally identical to sats-connect's
        // (same wire strings) but declared separately (network.ts stays free
        // of the sats-connect import); cast at the boundary.
        network: toBitcoinNetworkType(network) as unknown as BitcoinNetworkType,
      }).then((resp) => {
        if (resp.status !== 'success') {
          throw new Error(
            `Xverse wallet_connect failed: ${resp.error?.message ?? 'unknown error'} (code ${resp.error?.code ?? '?'})`,
          );
        }
        return parseXverseAddressResponse({ addresses: resp.result.addresses } as unknown as XverseAddressResponse);
      }),
    );
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
