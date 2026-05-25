import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import { isAlbyInstalled } from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from '../wallet.service.types';


interface AlbyWeblnApi {
  enable(): Promise<void>;
  getInfo(): Promise<{
    node?: { alias?: string; pubkey?: string };
    alby?: { lightning_address?: string };
  }>;
}


/**
 * Alby — sign-in-only.
 *
 * Alby is Lightning + Nostr focused. It does expose
 * `window.alby.bitcoin.signPsbt` per its bundle, but the on-chain
 * functionality is limited and isn't part of our supported CAT-21
 * mint flow. We connect Alby for **sign-in / identity** only:
 * `enable()` + `getInfo()` give us the user's Lightning address
 * (e.g. `alice@getalby.com`) and node alias, enough to identify
 * which Alby wallet authorized the SPA.
 *
 * `signingSupported: false` deliberately — the mint UI should
 * never route to an Alby signer because there isn't one. Calling
 * a hypothetical Alby signer would throw because no signer is
 * registered in `src/wallet/signers/`.
 *
 * `paymentAddress` and `ordinalsAddress` are populated with the
 * Lightning address (NOT an on-chain BTC address). Consumers that
 * inspect these for sending funds should check `signingSupported`
 * first; for sign-in the address is the identifier.
 */
export const albyConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.alby,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.alby],
  signingSupported: false,

  detect(win: WindowLike | undefined): boolean {
    return isAlbyInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    const alby = (window as unknown as { alby: AlbyWeblnApi }).alby;
    const p = alby.enable().then(() => alby.getInfo()).then(info => {
      const lnAddr = info?.alby?.lightning_address ?? info?.node?.alias ?? '';
      const lnPubkey = info?.node?.pubkey ?? '';
      return {
        type: KnownOrdinalWalletType.alby,
        ordinalsAddress:   lnAddr,
        ordinalsPublicKey: lnPubkey,
        paymentAddress:    lnAddr,
        paymentPublicKey:  lnPubkey,
        signingSupported:  false,
      };
    });
    return from(p).pipe(map(info => info as WalletInfo));
  },
};
