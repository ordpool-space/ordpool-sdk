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


interface AlbyBtcApi {
  getAddress(): Promise<{ address: string; publicKey: string } | string>;
}

interface AlbyWeblnApi {
  enable(): Promise<void>;
  getInfo(): Promise<{
    node?: { alias?: string; pubkey?: string };
    alby?: { lightning_address?: string };
  }>;
  getBitcoin?(): AlbyBtcApi;
}


/**
 * Alby — `window.alby.enable()` + WebBTC BTC sub-provider via
 * `getBitcoin()`.
 *
 * Alby implements three WebBTC methods (`getInfo`, `signPsbt`,
 * `getAddress`) on its BTC sub-provider. Address + signing
 * functionality both delegate to whichever on-chain backend the
 * user has wired up to their Alby account — Alby Hub, Mutiny,
 * etc. Users on a Lightning-only Alby account get runtime errors
 * from getAddress/signPsbt.
 *
 * Our connector tries the on-chain path (getBitcoin().getAddress)
 * and uses the BTC address when available. If the call fails or
 * the BTC sub-provider isn't there, we fall back to the user's
 * Lightning address from getInfo() — usable for sign-in
 * identification even when L1 isn't.
 *
 * `signingSupported: true` at the SDK level — the alby signer is
 * registered. Runtime behaviour determines whether actual signing
 * succeeds; users without an on-chain Alby backend see a clean
 * error rather than silent failure.
 */
export const albyConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.alby,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.alby],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isAlbyInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    const alby = (window as unknown as { alby: AlbyWeblnApi }).alby;
    const p = (async () => {
      await alby.enable();
      const info = await alby.getInfo();
      const lnAddr = info?.alby?.lightning_address ?? info?.node?.alias ?? '';
      const lnPubkey = info?.node?.pubkey ?? '';

      // Try the on-chain BTC sub-provider. Failure (no backend
      // wired up) is fine — we fall back to the LN identity.
      let onchainAddress = '';
      let onchainPubkey = '';
      try {
        const btc = alby.getBitcoin?.();
        if (btc) {
          const res = await btc.getAddress();
          // Alby's getAddress contract: returns either a plain
          // string (older variants) or {address, publicKey}. Normalise.
          if (typeof res === 'string') {
            onchainAddress = res;
          } else if (res && typeof res === 'object') {
            onchainAddress = res.address ?? '';
            onchainPubkey  = res.publicKey ?? '';
          }
        }
      } catch {
        // No on-chain backend → keep onchainAddress empty, fall through.
      }

      const address = onchainAddress || lnAddr;
      const publicKey = onchainPubkey || lnPubkey;

      return {
        type: KnownOrdinalWalletType.alby,
        ordinalsAddress:   address,
        ordinalsPublicKey: publicKey,
        paymentAddress:    address,
        paymentPublicKey:  publicKey,
        signingSupported:  true,
      };
    })();
    return from(p).pipe(map(info => info as WalletInfo));
  },
};
