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


interface WebBtcApi {
  enable?(): Promise<void>;
  getAddress(): Promise<{ address: string; publicKey: string } | string>;
}

interface WebLnApi {
  enable?(): Promise<void>;
  getInfo?(): Promise<{
    node?: { alias?: string; pubkey?: string };
    alby?: { lightning_address?: string };
  }>;
}

interface AlbyApi {
  enable(): Promise<void>;
  webbtc?: WebBtcApi;
  webln?: WebLnApi;
}


/**
 * Alby — `window.alby.enable()` + WebBTC sub-provider at
 * `alby.webbtc.getAddress()`.
 *
 * Verified iter 99 against background.bundle.js v3.14.2: alby's
 * sub-providers are `webbtc` / `webln` / `nostr` / `liquid`.
 * Methods live on the prototype: webbtc has `getInfo`, `signPsbt`,
 * `getAddress`, `sendTransaction`, `request`. There is no v2-style
 * `alby.getBitcoin()` and no top-level `alby.getInfo()`.
 *
 * Address derivation uses Alby's on-chain Taproot path
 * (m/86'/0'/0'/0/0 on mainnet, m/86'/1'/0'/0/0 on regtest/testnet)
 * from the user's BIP-39 mnemonic. Users with only a custodial
 * Lightning account get an error from webbtc.getAddress; we fall
 * back to the user's Lightning address from webln.getInfo() — still
 * useful for sign-in identification, just not for receiving sats.
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
    const alby = (window as unknown as { alby: AlbyApi }).alby;
    const p = (async () => {
      await alby.enable();

      // Try the on-chain BTC sub-provider first. Failure (no
      // backend wired up, no Bitcoin account, etc.) is fine — we
      // fall back to the Lightning identity below.
      let onchainAddress = '';
      let onchainPubkey = '';
      try {
        if (alby.webbtc?.enable) await alby.webbtc.enable();
        const res = await alby.webbtc?.getAddress();
        if (typeof res === 'string') {
          onchainAddress = res;
        } else if (res && typeof res === 'object') {
          onchainAddress = res.address ?? '';
          onchainPubkey  = res.publicKey ?? '';
        }
      } catch {
        // No on-chain backend → keep onchainAddress empty, fall through.
      }

      let lnAddr = '';
      let lnPubkey = '';
      if (!onchainAddress) {
        try {
          if (alby.webln?.enable) await alby.webln.enable();
          const info = await alby.webln?.getInfo?.();
          lnAddr = info?.alby?.lightning_address ?? info?.node?.alias ?? '';
          lnPubkey = info?.node?.pubkey ?? '';
        } catch {
          // No Lightning backend either — leave empty; consumer
          // sees the empty paymentAddress and can surface its own
          // "wallet not configured" message.
        }
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
