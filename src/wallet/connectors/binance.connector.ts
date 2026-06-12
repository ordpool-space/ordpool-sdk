import { from, map, Observable } from 'rxjs';

import { Network } from '../../network';
import {
  binanceBasicInfoToWalletInfo,
  isBinanceInstalled,
} from '../wallet.service.helper';
import {
  KnownOrdinalWallets,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from '../wallet.service.types';


interface BinanceBtcApi {
  requestAccounts(): Promise<string[]>;
  getPublicKey(): Promise<string>;
}

async function getBasicBinanceInfo(): Promise<{ address: string; publicKey: string }> {
  const binanceBtc = (window as unknown as { binancew3w: { bitcoin: BinanceBtcApi } }).binancew3w.bitcoin;
  const accounts = await binanceBtc.requestAccounts();
  const [address] = accounts;
  const publicKey = await binanceBtc.getPublicKey();
  return { address, publicKey };
}


/**
 * Binance Web3 Wallet — `window.binancew3w.bitcoin.*`.
 *
 * Shape per the official developer docs at developers.binance.com
 * /docs/binance-w3w/bitcoin-provider: requestAccounts /
 * getPublicKey / getNetwork / switchNetwork / getBalance /
 * signMessage / signPsbt. Single-address contract (the docs say
 * Binance "proxies window.unisat with some API differences"),
 * meaning ordinals + payment lanes both use the same address.
 *
 * **Runtime status (v1.17.2 disassembly, 2026-06-12):** the
 * shipped Chrome Web Store binary injects only
 * `window.binancew3w.{wallet, ethereum, solana, tron, sui,
 * tonconnect}` — no `.bitcoin` sub-provider. So detect returns
 * false on current binaries; this connector ships as
 * potential-support, ready to light up the moment Binance
 * exposes the documented surface.
 *
 * Adapter shape modelled after LaserEyes'
 * `packages/core/src/client/providers/binance.ts` which is in
 * production use across multiple Ordinals-related projects.
 *
 * TODO: handle accountsChanged / networkChanged events.
 */
export const binanceConnector: WalletConnector = {
  providerId: KnownOrdinalWalletType.binance,
  wallet: KnownOrdinalWallets[KnownOrdinalWalletType.binance],
  signingSupported: true,

  detect(win: WindowLike | undefined): boolean {
    return isBinanceInstalled(win);
  },

  connect(_network: Network): Observable<WalletInfo> {
    return from(getBasicBinanceInfo()).pipe(
      map(({ address, publicKey }) => binanceBasicInfoToWalletInfo(address, publicKey))
    );
  },
};
