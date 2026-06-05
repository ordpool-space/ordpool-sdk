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
 * `addressType` values are p2tr / p2wpkh / p2sh / p2pkh (prefix
 * `bip122_` is stripped by the in-page provider before return).
 * Phantom returns both taproot (ordinals) and the user's selected
 * payment address type by default.
 *
 * Disassembly of v26.14.0 btc.js (class $u extends Lh, see
 * comment in phantom.signer.ts for byte offsets): the in-page
 * provider exposes direct methods `requestAccounts() / signPSBT() /
 * signMessage()`, NOT a generic `request({method, params})` RPC.
 * The JSON-RPC method names ("btc_requestAccounts" etc) are
 * internal — they're the schema literals used by the in-page
 * proxy when it talks to the SW.
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
    return from(phantomBtc.requestAccounts()).pipe(
      map(addresses => parsePhantomAddressResponse(addresses)),
    );
  },
};
