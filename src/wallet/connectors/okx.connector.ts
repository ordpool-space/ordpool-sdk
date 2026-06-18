import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import {
  isOkxInstalled,
  okxBasicInfoToWalletInfo,
} from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from '../wallet.service.types';


interface OkxBtcApi {
  requestAccounts(): Promise<unknown>;
  getAccounts(): Promise<string[]>;
  getPublicKey(): Promise<string>;
  on?(event: 'accountChanged' | 'networkChanged', handler: () => void): void;
  removeListener?(event: 'accountChanged' | 'networkChanged', handler: () => void): void;
}

async function getBasicOkxInfo(): Promise<{ address: string; publicKey: string }> {
  const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcApi } }).okxwallet.bitcoin;
  await okxBtc.requestAccounts();
  const [address] = await okxBtc.getAccounts();
  const publicKey = await okxBtc.getPublicKey();
  return { address, publicKey };
}


/**
 * OKX — `window.okxwallet.bitcoin.*` (the BTC sub-provider of OKX's
 * multi-chain wallet).
 *
 * Single-address contract per active type (BIP-84 / 49 / 86 / 44 —
 * user picks one in OKX settings, and that becomes the active
 * `bitcoin` provider's address). Same "NOT safe for cat sats"
 * caveat as Unisat / Wizz because both ordinals and payment lanes
 * come from the one address.
 *
 * Event surface: OKX exposes `accountChanged` (singular — different
 * from Unisat's plural) and `networkChanged` on the BTC sub-
 * provider. We fan both into the single `onAccountChange` callback.
 */
export const okxConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.okx,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.okx],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isOkxInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    return from(getBasicOkxInfo()).pipe(
      map(({ address, publicKey }) => okxBasicInfoToWalletInfo(address, publicKey))
    );
  },

  onAccountChange(handler: () => void): () => void {
    const okxBtc = (window as unknown as { okxwallet?: { bitcoin?: OkxBtcApi } }).okxwallet?.bitcoin;
    if (!okxBtc?.on || !okxBtc.removeListener) return () => undefined;
    okxBtc.on('accountChanged', handler);
    okxBtc.on('networkChanged', handler);
    return () => {
      okxBtc.removeListener!('accountChanged', handler);
      okxBtc.removeListener!('networkChanged', handler);
    };
  },
};
