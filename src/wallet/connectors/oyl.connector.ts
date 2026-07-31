import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import { toRegtestWalletInfo } from '../network-address-shim';
import {
  isOylInstalled,
  OylAddressResponse,
  parseOylAddressResponse,
} from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from '../wallet.service.types';


interface OylApi {
  getAddresses(): Promise<OylAddressResponse>;
}


/**
 * Oyl — `window.oyl.getAddresses()` returns a `{nativeSegwit,
 * nestedSegwit?, taproot}` record. Like Xverse / Leather / Phantom,
 * Oyl exposes proper ordinals vs payment lane separation — safer
 * for cat sats than the single-address Unisat/Wizz/OKX wallets.
 *
 * Schema verified in static/background/index.js v1.17.1.
 */
export const oylConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.oyl,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.oyl],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isOylInstalled(win);
  },

  connect(network: Network): Observable<WalletInfo> {
    const oyl = (window as unknown as { oyl: OylApi }).oyl;
    return from(oyl.getAddresses()).pipe(
      map(addresses => parseOylAddressResponse(addresses)),
      map(info => network === Network.Regtest ? toRegtestWalletInfo(info) : info),
    );
  },
};
