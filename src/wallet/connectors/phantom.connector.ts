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
  on?(event: 'accountsChanged' | 'networkChanged', handler: () => void): void;
  removeListener?(event: 'accountsChanged' | 'networkChanged', handler: () => void): void;
}


/**
 * Phantom — `window.phantom.bitcoin.requestAccounts()` returns an
 * array of `{address, publicKey, addressType, purpose}` entries.
 * `addressType` values are p2tr / p2wpkh / p2sh / p2pkh (the
 * `bip122_` prefix is stripped by the in-page provider).
 *
 * Disassembly of v26.14.0 + v26.16.0 (iters 47-83) confirmed the
 * current Chrome Web Store extension ships btc.js dormant: the SW
 * has zero `btc_*` handlers and the conditional content-script
 * registrar lacks a Bitcoin case. So `window.phantom.bitcoin` is
 * absent on the desktop extension and `isPhantomInstalled` returns
 * false there — the connector simply doesn't surface as installed,
 * no special-casing required.
 *
 * On Phantom's mobile in-app browser (iOS/Android), the BTC
 * sub-provider IS exposed per docs.phantom.com/bitcoin/sending-a-
 * transaction. When that signature is present, this connector
 * picks the wallet up just like any other. Detect-by-signature is
 * the single source of truth — we don't try to pre-judge platforms.
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
    return from(phantomBtc.requestAccounts()).pipe(
      map(addresses => parsePhantomAddressResponse(addresses)),
    );
  },

  /**
   * Per docs.phantom.com, the BTC sub-provider exposes EIP-1193-style
   * events. Desktop ships btc.js dormant so detect already returns
   * false and we never reach this code there. On mobile in-app browsers
   * (and any future desktop build that re-enables the SW handlers) the
   * subscription wires up automatically. Safe no-op when `.on` is
   * absent.
   */
  onAccountChange(handler: () => void): () => void {
    const phantomBtc = (window as unknown as { phantom?: { bitcoin?: PhantomBtcApi } }).phantom?.bitcoin;
    if (!phantomBtc?.on || !phantomBtc.removeListener) return () => undefined;
    phantomBtc.on('accountsChanged', handler);
    phantomBtc.on('networkChanged', handler);
    return () => {
      phantomBtc.removeListener!('accountsChanged', handler);
      phantomBtc.removeListener!('networkChanged', handler);
    };
  },
};
