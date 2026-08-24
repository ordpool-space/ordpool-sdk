import { from, map, Observable } from 'rxjs';
import { addListener, AddressPurpose, BitcoinNetworkType, request } from 'sats-connect';

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
 * Xverse — sats-connect v4 `wallet_connect` RPC.
 *
 * We invoke the low-level `request` helper from `sats-connect` (the
 * function re-exported from `@sats-connect/core`), NOT the default
 * `Wallet.request` method. `Wallet.request` wraps every call in
 * sats-connect's own in-page UI (`loadSelector` → `selectProvider` →
 * `walletOpen`); with no default provider set that renders an in-page
 * wallet-picker modal that a headless / programmatic caller can never
 * dismiss, so the call hangs. The bare `request` resolves
 * `window.XverseProviders.BitcoinProvider` directly and calls it with
 * no modal — the same transport `getAddress` used.
 *
 * `wallet_connect` sets the SESSION network (returned in the response
 * envelope). The signer's modern `signPsbt` carries no per-request
 * network and inherits this session network, so connect and sign must
 * agree on the network established here.
 */
export const xverseConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.xverse,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.xverse],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isXverseInstalled(win);
  },

  connect(network: Network): Observable<WalletInfo> {
    // sats-connect's BitcoinNetworkType is structurally identical to
    // ours (the same wire-protocol strings), but TS treats them as
    // distinct types because they're declared in different modules.
    // Our `network.ts` deliberately doesn't import from sats-connect
    // (it would drag axios into the /core bundle); the runtime strings
    // agree exactly. Cast at the boundary.
    const networkType = toBitcoinNetworkType(network) as unknown as BitcoinNetworkType;
    return from(request('wallet_connect', {
      addresses: [AddressPurpose.Ordinals, AddressPurpose.Payment],
      message: 'Connect to receive Ordinals and payments.',
      network: networkType,
    })).pipe(
      map((response) => {
        if (response.status !== 'success') {
          throw new Error(
            `Xverse wallet_connect failed: ${response.error?.message ?? 'unknown error'} (code ${response.error?.code ?? '?'})`,
          );
        }
        // wallet_connect's result addresses carry extra fields
        // (addressType, walletType) beyond what getAddress returned;
        // parseXverseAddressResponse reads only {address, publicKey,
        // purpose}, so the shape is a superset — safe to pass through.
        return parseXverseAddressResponse({ addresses: response.result.addresses } as unknown as XverseAddressResponse);
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
