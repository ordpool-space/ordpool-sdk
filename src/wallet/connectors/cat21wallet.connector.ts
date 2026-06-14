import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import {
  findCat21WalletProvider,
  isCat21WalletInstalled,
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
 * Cat21 Wallet — `window.Cat21Provider.request('getAddresses')`.
 *
 * Cat21 Wallet is our own Bitcoin-L1 wallet, forked from Leather.
 * The wire protocol for the Bitcoin RPC subset (`getAddresses`,
 * `signPsbt`, `signMessage`, `sendTransfer`, `getInfo`,
 * `supportedMethods`, `open`) is identical to Leather's, so the
 * response parser is shared.
 *
 * Discovery rules per the wallet's INTEGRATION-ORDPOOL-SDK.md
 * contract:
 *   - `window.Cat21Provider` is ALWAYS present when Cat21 Wallet
 *     is installed.
 *   - The provider self-identifies with `isCat21: true`. Branch
 *     on this for positive identification, NOT on `isLeather`
 *     (which would also match real Leather).
 *   - The wallet politely backfills `window.LeatherProvider` only
 *     when real Leather is NOT installed; `isLeatherInstalled`
 *     filters out `isCat21` providers so the picker shows each
 *     wallet exactly once.
 *   - WBIP004 backup discovery: `window.btc_providers[]` carries a
 *     `{ id: 'Cat21Provider' }` entry.
 *
 * Stacks methods (`stx_*`) are not registered by the wallet — they
 * return `METHOD_NOT_FOUND`, not a hang. Cat21 Wallet is BTC L1
 * mainnet only per the wallet's ADR-7.
 */
export const cat21walletConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.cat21wallet,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.cat21wallet],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isCat21WalletInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    const provider = findCat21WalletProvider(window as unknown as WindowLike);
    if (!provider) {
      throw new Error('Cat21 Wallet provider not present (window.Cat21Provider undefined or missing isCat21:true marker)');
    }
    return from(provider.request('getAddresses') as Promise<LeatherAddressResponse>).pipe(
      map(resp => {
        const info = parseLeatherAddressResponse(resp);
        // Stamp our own wallet type so consumers branch on Cat21
        // Wallet rather than mistaking us for Leather (the parser
        // sets `type: leather` because it's shared with the
        // Leather connector).
        return { ...info, type: KnownOrdinalWalletType.cat21wallet };
      }),
    );
  },
};
