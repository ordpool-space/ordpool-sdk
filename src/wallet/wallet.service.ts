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

import {
  AddressNetworkGroup,
  getAddressNetwork,
  isAddressCompatibleWithNetwork,
} from '../cat21-script/address-format';
import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { detectInstalledWallets, walletConnectors } from './connectors';
import { findSignerOrThrow } from './signers';
import {
  KnownOrdinalWallet,
  KnownOrdinalWalletType,
  SignMessageArgs,
  SignMessageResult,
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

  /**
   * Coarse network group ('mainnet' | 'regtest' | 'testnet') the
   * consumer is configured against. Compared against the connected
   * wallet's address prefix to surface the "wrong network" red banner.
   */
  readonly expectedNetworkGroup: AddressNetworkGroup =
    this.network === Network.Mainnet ? 'mainnet'
      : this.network === Network.Regtest ? 'regtest'
        : 'testnet';

  /**
   * Emits `true` when the connected wallet's address prefix is
   * incompatible with the configured network. Consumers wire this
   * directly to a red-banner component. `false` when no wallet is
   * connected (nothing to compare against) AND when the prefix
   * matches the expected group.
   */
  readonly networkMismatch$: Observable<boolean> = this.connectedWallet$.pipe(
    map((info) => {
      if (!info?.paymentAddress) return false;
      try {
        return !isAddressCompatibleWithNetwork(info.paymentAddress, this.expectedNetworkGroup);
      } catch {
        // Unrecognized prefix counts as a mismatch — better to warn
        // than to silently accept an unknown shape.
        return true;
      }
    }),
    distinctUntilChanged(),
  );

  /**
   * Last-seen unsubscribe handle returned by the active connector's
   * onAccountChange. Lives across reconnects; cleared on disconnect.
   */
  private accountChangeUnsubscribe: (() => void) | null = null;

  constructor() {
    const lastConnectedWallet = this.storageService.getValue(LAST_CONNECTED_WALLET);
    if (lastConnectedWallet) {
      const info: WalletInfo = JSON.parse(lastConnectedWallet);
      this.connectedWallet$.next(info);
      // Restore the event subscription so an account-switch fires
      // even if the user only refreshed the page.
      this.armAccountChangeSubscription(info.type);
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

  connectWallet(key: KnownOrdinalWalletType): Observable<WalletInfo> {
    return this.findConnector(key).connect(this.network).pipe(
      tap(walletInfo => this.storageService.setValue(LAST_CONNECTED_WALLET, JSON.stringify(walletInfo))),
      tap(walletInfo => this.connectedWallet$.next(walletInfo)),
      tap(walletInfo => this.armAccountChangeSubscription(walletInfo.type)),
    );
  }

  connectFakeWallet(walletInfo: WalletInfo): void {
    this.storageService.setValue(LAST_CONNECTED_WALLET, JSON.stringify(walletInfo));
    this.connectedWallet$.next(walletInfo);
  }

  disconnectWallet(): void {
    // eslint-disable-next-line no-console
    console.error('[wallet.service] disconnectWallet called from:', new Error().stack);
    this.tearDownAccountChangeSubscription();
    this.storageService.removeItem(LAST_CONNECTED_WALLET);
    this.connectedWallet$.next(null);
  }

  /**
   * Sign a UTF-8 message with the connected wallet's ordinals key via
   * BIP-322. Consumers hand in `{address, message, network}` (usually
   * `address = wallet.ordinalsAddress`, `network = this.network`) and
   * get back the base64 signature. Dispatches to the appropriate
   * `WalletSigner.signMessage` under the hood; wallets whose
   * signMessage isn't wired yet emit a "not supported" error the
   * caller surfaces to the user.
   *
   * Used by the CAT-21 orderbook flow to prove seller ownership
   * without moving any sats. See `buildListingMessage` /
   * `verifyListingSignature` for the message shape + verifier.
   */
  signMessage(input: SignMessageArgs): Observable<SignMessageResult> {
    const wallet = this.connectedWallet$.getValue();
    if (!wallet) {
      return new Observable<SignMessageResult>((observer) => {
        observer.error(new Error('No wallet connected'));
      });
    }
    return findSignerOrThrow(wallet.type).signMessage(input);
  }

  /**
   * Subscribe to the connector's `onAccountChange` (if exposed). When
   * the wallet emits an account / network / disconnect event we
   * re-call `connect()` silently — most wallets return the current
   * account without a popup once the user has previously approved.
   * The fresh WalletInfo overwrites the cached one, so the UI
   * updates automatically through `connectedWallet$`. On failure we
   * disconnect (the wallet has lost the connection).
   */
  private armAccountChangeSubscription(type: KnownOrdinalWalletType): void {
    this.tearDownAccountChangeSubscription();
    const connector = this.findConnector(type);
    if (!connector.onAccountChange) return;
    this.accountChangeUnsubscribe = connector.onAccountChange(() => {
      connector.connect(this.network).subscribe({
        next: (info) => {
          this.storageService.setValue(LAST_CONNECTED_WALLET, JSON.stringify(info));
          this.connectedWallet$.next(info);
        },
        // Don't disconnect on a transient reconnect error. Xverse fires
        // onAccountChange repeatedly on regtest (and on hot chain-changes
        // in general); each fire re-calls `connect()`, which triggers a
        // fresh sats-connect popup. If that popup doesn't complete before
        // the observable errors, disconnecting drops LAST_CONNECTED_WALLET
        // and next(null)s — then the next onAccountChange fires connect
        // again → next(wallet), causing downstream utxos$/simulations$ to
        // flap between idle/ready fast enough that consumer UIs never
        // settle their found-funds banner. Keep the cached wallet in
        // place; the user can explicitly Disconnect if they want.
        error: (err) => {
          console.warn('[wallet.service] onAccountChange reconnect failed; keeping cached wallet', err);
        },
      });
    });
  }

  private tearDownAccountChangeSubscription(): void {
    if (this.accountChangeUnsubscribe) {
      this.accountChangeUnsubscribe();
      this.accountChangeUnsubscribe = null;
    }
  }

  requestWalletConnect(): void {
    this.walletConnectRequested$.next(true);
  }
}
