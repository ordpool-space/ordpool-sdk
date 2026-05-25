import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import {
  isPhantomInstalled,
  parsePhantomAddressResponse,
  PhantomBtcAddress,
} from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from '../wallet.service.types';


interface PhantomBtcApi {
  request(args: { method: 'btc_requestAccounts'; params: [] }): Promise<PhantomBtcAddress[]>;
}


/**
 * Phantom — `window.phantom.bitcoin.request({method:
 * "btc_requestAccounts", params: []})` returns an array of
 * `{address, publicKey, addressType}` entries. Phantom v26 returns
 * both taproot (ordinals) and the user's selected payment address
 * type by default. Our parser splits by addressType.
 *
 * Unlike Unisat / Wizz / OKX (one address total), Phantom exposes
 * proper ordinals vs payment lane separation — closer to Xverse /
 * Leather in safety.
 */
export const phantomConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.phantom,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.phantom],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isPhantomInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    const phantomBtc = (window as unknown as { phantom: { bitcoin: PhantomBtcApi } }).phantom.bitcoin;
    return from(phantomBtc.request({ method: 'btc_requestAccounts', params: [] })).pipe(
      map(addresses => parsePhantomAddressResponse(addresses)),
    );
  },
};
