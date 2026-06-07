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
  requestAccounts(): Promise<PhantomBtcAddress[]>;
}


/**
 * Phantom — `window.phantom.bitcoin.requestAccounts()` returns an
 * array of `{address, publicKey, addressType, purpose}` entries.
 * `addressType` values are p2tr / p2wpkh / p2sh / p2pkh (the
 * `bip122_` prefix is stripped by the in-page provider).
 *
 * **`signingSupported: false`.** Phantom's own Help Center states
 * "Phantom does not support connecting to dApps on Bitcoin"
 * (help.phantom.com/hc/en-us/articles/29995498642195). Empirical
 * v26.16.0 disassembly confirms: btc.js ships dormant in the
 * bundle, the SW has no `btc_*` handlers (returns "isn't
 * implemented" or "not permitted" for direct probes), the
 * conditional content-script registrar's chain enum lacks a
 * Bitcoin case. So in-page `requestAccounts() / signPSBT()` calls
 * always fail in the current shipped extension.
 *
 * The connector + signer are kept registered (matching the
 * documented API surface for the day Phantom's Wallet-Standard
 * Bitcoin successor lands per their deprecation banner) but
 * `signingSupported: false` filters Phantom out of signing flows
 * in the picker UI — same pattern as Alby for Lightning-only
 * accounts. Detect returns false in practice anyway (it checks
 * `window.phantom.bitcoin` which the current build doesn't expose),
 * so Phantom usually surfaces as "not installed" for BTC.
 */
export const phantomConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.phantom,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.phantom],
  signingSupported: false,

  detect(win: WindowLike | undefined): boolean {
    return isPhantomInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    const phantomBtc = (window as unknown as { phantom: { bitcoin: PhantomBtcApi } }).phantom.bitcoin;
    return from(phantomBtc.requestAccounts()).pipe(
      map(addresses => parsePhantomAddressResponse(addresses)),
    );
  },
};
