import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import {
  isUnisatInstalled,
  unisatBasicInfoToWalletInfo,
} from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from '../wallet.service.types';


interface UnisatApi {
  requestAccounts(): Promise<unknown>;
  getAccounts(): Promise<string[]>;
  getPublicKey(): Promise<string>;
  on?(event: 'accountsChanged' | 'networkChanged', handler: () => void): void;
  removeListener?(event: 'accountsChanged' | 'networkChanged', handler: () => void): void;
}

// as seen here: https://github.com/unisat-wallet/unisat-web3-demo/blob/1109c79b07517ef4abe069c0c80b2d2118915e19/src/App.tsx#L18
async function getBasicUnisatInfo(): Promise<{ address: string; publicKey: string }> {
  const unisat = (window as unknown as { unisat: UnisatApi }).unisat;
  await unisat.requestAccounts();

  // gets the address of the current account (which is only one, so it's weird that this is an array)
  const [address] = await unisat.getAccounts();
  const publicKey = await unisat.getPublicKey();

  return { address, publicKey };
}


/**
 * Unisat — `window.unisat.*` directly.
 *
 * Warning: Unisat uses the same address for payments and ordinals,
 * which makes accidentally-spending cat sats easy. See CLAUDE.md
 * note: "Unisat is NOT safe for cat sats". We still ship the
 * connector because Unisat users exist; mint UI surfaces the caveat.
 *
 * `accountsChanged` + `networkChanged` events come from Unisat's
 * EIP-1193-ish event API on the in-page provider; we fan both into
 * the single `onAccountChange` callback so consumers can invalidate
 * caches without caring which axis flipped.
 */
export const unisatConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.unisat,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.unisat],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isUnisatInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    return from(getBasicUnisatInfo()).pipe(
      map(({ address, publicKey }) => unisatBasicInfoToWalletInfo(address, publicKey))
    );
  },

  onAccountChange(handler: () => void): () => void {
    const unisat = (window as unknown as { unisat?: UnisatApi }).unisat;
    if (!unisat?.on || !unisat.removeListener) return () => undefined;
    unisat.on('accountsChanged', handler);
    unisat.on('networkChanged', handler);
    return () => {
      unisat.removeListener!('accountsChanged', handler);
      unisat.removeListener!('networkChanged', handler);
    };
  },
};
