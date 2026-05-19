import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import {
  isLeatherInstalled,
  parseLeatherAddressResponse,
} from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  LeatherAddressResponse,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from '../wallet.service.types';


/**
 * Leather — `window.LeatherProvider.request(method, params)`.
 *
 * Namespace matters: the historical Hiro wallet exposed `window.btc`,
 * which other wallets (notably Unisat at times) have aggressively
 * overwritten. Calling `window.btc.request(...)` with mixed
 * extensions installed can route to the wrong wallet. Leather's
 * post-rebrand global `window.LeatherProvider` is unique to Leather
 * and immune to that collision.
 *
 * LaserEyes solves it the same way — see
 * `lasereyes-mono/packages/core/src/client/providers/leather.ts:38-39`.
 */
export const leatherConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.leather,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.leather],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isLeatherInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    return from(
      (window as unknown as { LeatherProvider: { request(method: string): Promise<LeatherAddressResponse> } })
        .LeatherProvider.request('getAddresses')
    ).pipe(
      map(parseLeatherAddressResponse)
    );
  },
};
