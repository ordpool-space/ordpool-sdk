import { inject, Injectable } from '@angular/core';
import {
  BehaviorSubject,
  distinctUntilChanged,
  from,
  map,
  Observable,
  of,
  Subject,
  take,
  tap,
  timer,
} from 'rxjs';
import { AddressPurpose, getAddress } from 'sats-connect';

import { Network, toBitcoinNetworkType } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import {
  detectInstalledWallets,
  isLeatherInstalled,
  isUnisatInstalled,
  isXverseInstalled,
  parseLeatherAddressResponse,
  parseXverseAddressResponse,
  unisatBasicInfoToWalletInfo,
  WindowLike,
} from './wallet.service.helper';
import {
  KnownOrdinalWallet,
  KnownOrdinalWalletType,
  LeatherAddressResponse,
  WalletInfo,
  XverseAddressResponse,
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

  getInstalledWallets(): {
    installedWallets: KnownOrdinalWallet[];
    notInstalledWallets: KnownOrdinalWallet[];
  } {
    return detectInstalledWallets(this.win);
  }

  getUnisatInstalled(): boolean {
    return isUnisatInstalled(this.win);
  }

  getLeatherInstalled(): boolean {
    return isLeatherInstalled(this.win);
  }

  getXverseInstalled(): boolean {
    return isXverseInstalled(this.win);
  }

  connectWallet(key: KnownOrdinalWalletType): Observable<WalletInfo> {

    let obs: Observable<WalletInfo>;
    switch (key) {
      case KnownOrdinalWalletType.xverse:
        obs = this.connectWalletXverse();
        break;
      case KnownOrdinalWalletType.leather:
        obs = this.connectWalletLeather();
        break;
      case KnownOrdinalWalletType.unisat:
        obs = this.connectWalletUnisat();
        break;
      default:
        // exhaustive — every enum case is handled above
        throw new Error(`Unknown wallet type: ${key as string}`);
    }

    return obs.pipe(
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
   * Get adresses:
   * see also: https://docs.xverse.app/sats-connect/get-address
   */
  connectWalletXverse(): Observable<WalletInfo> {

    return new Observable<WalletInfo>((observer) => {
      getAddress({
        payload: {
          purposes: [AddressPurpose.Ordinals, AddressPurpose.Payment],
          message: 'Please share your address for receiving Ordinals and payments.',
          network: {
            type: toBitcoinNetworkType(this.network)
          }
        },
        onFinish: (response) => {
          try {
            observer.next(parseXverseAddressResponse(response as XverseAddressResponse));
            observer.complete();
          } catch (error) {
            observer.error(error);
          }
        },
        onCancel: () => {
          observer.error(new Error('Request was cancelled'));
        }
      });
    });
  }

  /**
   * Get addresses
   * see also: https://leather.gitbook.io/developers/bitcoin/connect-users/get-addresses
   */
  connectWalletLeather(): Observable<WalletInfo> {

    return from((window as any).btc.request('getAddresses') as Promise<LeatherAddressResponse>).pipe(
      map(parseLeatherAddressResponse)
    );
  }

  // as seen here: https://github.com/unisat-wallet/unisat-web3-demo/blob/1109c79b07517ef4abe069c0c80b2d2118915e19/src/App.tsx#L18
  private async getBasicUnisatInfo(): Promise<{ address: string, publicKey: string }> {

    const unisat = (window as any).unisat;
    await unisat.requestAccounts();

    // gets the address of the current account (which is only one, so it's weird that this is an array)
    const [address] = await unisat.getAccounts();
    const publicKey = await unisat.getPublicKey();
    // const balance = await unisat.getBalance();
    // const network = await unisat.getNetwork();

    return { address, publicKey };
  }

  /**
   * Get addresses
   * see https://docs.unisat.io/dev/unisat-developer-service/unisat-wallet#requestaccounts
   *
   * Warning: Unisat uses the same address for payments and ordinals! 😱
   *
   * TODO: handle accountsChanged / networkChanged!!
   */
  connectWalletUnisat(): Observable<WalletInfo> {
    return from(this.getBasicUnisatInfo()).pipe(
      map(({ address, publicKey }) => unisatBasicInfoToWalletInfo(address, publicKey))
    );
  }
}
