import { inject, Injectable } from '@angular/core';
import {
  BehaviorSubject,
  distinctUntilChanged,
  map,
  Observable,
  of,
  Subject,
  take,
  tap,
  timer,
} from 'rxjs';

import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { walletConnectors } from './connectors';
import { detectInstalledWallets } from './wallet.service.helper';
import {
  KnownOrdinalWallet,
  KnownOrdinalWalletType,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from './wallet.service.types';


// Re-exports for backwards compatibility — these used to live here
// before the pure-logic extraction. Consumers still import them from
// this module.
export { leatherOrdinalsAddressType, leatherPaymentAddressType } from './wallet.service.helper';

export const LAST_CONNECTED_WALLET = 'LAST_CONNECTED_WALLET';


@Injectable({ providedIn: 'root' })
export class WalletService {

  storageService = inject(storage);
  network = inject(bitcoinNetwork);

  walletConnectRequested$ = new Subject<boolean>();

  connectedWallet$ = new BehaviorSubject<WalletInfo | null>(null);
  wallets$ = timer(0, 500) // Start immediately and repeat every 500ms
    .pipe(
      take(4), // Take 4 intervals only, i.e., perform the check four times
      map(() => this.getInstalledWallets()),
      distinctUntilChanged((prev, curr) => {
        return JSON.stringify(prev) === JSON.stringify(curr);
      })
    );

  // Static derivation from the injected network. Kept as a boolean field
  // (read by frontend consumers that pick a mainnet-vs-testnet endpoint)
  // and as a single-emission Observable for legacy subscribers — neither
  // ever changes after construction; ordpool no longer routes a testnet UI.
  readonly isMainnet = this.network === Network.Mainnet;
  readonly isMainnet$: Observable<boolean> = of(this.isMainnet);

  constructor() {
    const lastConnectedWallet = this.storageService.getValue(LAST_CONNECTED_WALLET);
    if (lastConnectedWallet) {
      this.connectedWallet$.next(JSON.parse(lastConnectedWallet));
    }
  }

  private get win(): WindowLike | undefined {
    return typeof window === 'undefined' ? undefined : (window as unknown as WindowLike);
  }

  private findConnector(type: KnownOrdinalWalletType): WalletConnector {
    const connector = walletConnectors.find(c => c.providerId === type);
    if (!connector) {
      throw new Error(`Unknown wallet type: ${type as string}`);
    }
    return connector;
  }

  getInstalledWallets(): {
    installedWallets: KnownOrdinalWallet[];
    notInstalledWallets: KnownOrdinalWallet[];
  } {
    return detectInstalledWallets(this.win);
  }

  getXverseInstalled(): boolean {
    return this.findConnector(KnownOrdinalWalletType.xverse).detect(this.win);
  }

  getLeatherInstalled(): boolean {
    return this.findConnector(KnownOrdinalWalletType.leather).detect(this.win);
  }

  getUnisatInstalled(): boolean {
    return this.findConnector(KnownOrdinalWalletType.unisat).detect(this.win);
  }

  connectWallet(key: KnownOrdinalWalletType): Observable<WalletInfo> {
    return this.findConnector(key).connect(this.network).pipe(
      tap(walletInfo => this.storageService.setValue(LAST_CONNECTED_WALLET, JSON.stringify(walletInfo))),
      tap(walletInfo => this.connectedWallet$.next(walletInfo))
    );
  }

  connectFakeWallet(walletInfo: WalletInfo): void {
    this.storageService.setValue(LAST_CONNECTED_WALLET, JSON.stringify(walletInfo));
    this.connectedWallet$.next(walletInfo);
  }

  disconnectWallet(): void {
    this.storageService.removeItem(LAST_CONNECTED_WALLET);
    this.connectedWallet$.next(null);
  }

  requestWalletConnect(): void {
    this.walletConnectRequested$.next(true);
  }

  /**
   * @deprecated Use `connectWallet(KnownOrdinalWalletType.xverse)`.
   * Kept for the few legacy callers; will be removed once the frontend
   * routes everything through the high-level façade.
   */
  connectWalletXverse(): Observable<WalletInfo> {
    return this.findConnector(KnownOrdinalWalletType.xverse).connect(this.network);
  }

  /** @deprecated Use `connectWallet(KnownOrdinalWalletType.leather)`. */
  connectWalletLeather(): Observable<WalletInfo> {
    return this.findConnector(KnownOrdinalWalletType.leather).connect(this.network);
  }

  /** @deprecated Use `connectWallet(KnownOrdinalWalletType.unisat)`. */
  connectWalletUnisat(): Observable<WalletInfo> {
    return this.findConnector(KnownOrdinalWalletType.unisat).connect(this.network);
  }
}
