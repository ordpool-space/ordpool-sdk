import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import {
  isWizzInstalled,
  wizzBasicInfoToWalletInfo,
} from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from '../wallet.service.types';


interface WizzApi {
  requestAccounts(): Promise<unknown>;
  getAccounts(): Promise<string[]>;
  getPublicKey(): Promise<string>;
}

async function getBasicWizzInfo(): Promise<{ address: string; publicKey: string }> {
  const wizz = (window as unknown as { wizz: WizzApi }).wizz;
  await wizz.requestAccounts();
  const [address] = await wizz.getAccounts();
  const publicKey = await wizz.getPublicKey();
  return { address, publicKey };
}


/**
 * Wizz — `window.wizz.*` (also injected as `window.atom` for legacy
 * Atom Wallet compatibility; both reference the same provider).
 *
 * Wizz is a Unisat fork: same getAccounts/getPublicKey/signPsbt
 * shape, same single-address constraint. The "Unisat is NOT safe
 * for cat sats" warning applies here too — one address for both
 * payments and ordinals.
 *
 * TODO: handle accountsChanged / networkChanged events.
 */
export const wizzConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.wizz,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.wizz],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isWizzInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    return from(getBasicWizzInfo()).pipe(
      map(({ address, publicKey }) => wizzBasicInfoToWalletInfo(address, publicKey))
    );
  },
};
