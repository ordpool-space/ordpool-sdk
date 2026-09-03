import {
  BehaviorSubject,
  defer,
  distinctUntilChanged,
  from,
  map,
  Observable,
  of,
  Subject,
  switchMap,
  take,
  tap,
  throwError,
  timer,
} from 'rxjs';

import {
  AddressNetworkGroup,
  getAddressNetwork,
  isAddressCompatibleWithNetwork,
} from '../cat21-script/address-format';
import { Network } from '../network';
import { StorageLike } from '../storage-like';
import { detectInstalledWallets, walletConnectors } from './connectors';
import { findSignerOrThrow } from './signers';
import { verifyBip322Signature } from './verify-bip322-signature';
import { WatchOnlyAddress, WatchOnlyScriptType } from './xpub/derive-watch-only';
import { AddressProbe, WatchOnlyScanResult, scanWatchOnly } from './xpub/scan-watch-only';
import {
  KnownOrdinalWallet,
  KnownOrdinalWalletType,
  KnownOrdinalWallets,
  SignMessageArgs,
  SignMessageResult,
  WalletConnector,
  WalletInfo,
  WindowLike,
} from './wallet.service.types';


// Re-exports kept for backward compatibility: consumers import these from
// this module, though the implementations live in wallet.service.helper.
export { leatherOrdinalsAddressType, leatherPaymentAddressType } from './wallet.service.helper';

export const LAST_CONNECTED_WALLET = 'LAST_CONNECTED_WALLET';

/**
 * Guard that a parsed `LAST_CONNECTED_WALLET` payload has the fields
 * the constructor is about to dereference. Prevents both malformed
 * JSON (caught upstream by try/catch) and schema-drifted payloads
 * from wedging Angular DI. Deliberately lax on optional fields —
 * only asserts the four the constructor + armAccountChangeSubscription
 * actually read. Extra fields pass through untouched; missing extras
 * become undefined and reveal themselves later on flow-specific paths
 * where a re-connect prompt is the right recovery.
 *
 * Exported for direct spec coverage — the constructor is behind
 * Angular DI, this helper isn't.
 */
export function isValidPersistedWalletInfo(v: unknown): v is WalletInfo {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const isHex = (s: unknown): s is string =>
    typeof s === 'string' && s.length > 0 && /^[0-9a-f]+$/i.test(s);
  return (
    typeof o.type === 'string' &&
    o.type in KnownOrdinalWallets &&
    typeof o.ordinalsAddress === 'string' && o.ordinalsAddress.length > 0 &&
    typeof o.paymentAddress === 'string' && o.paymentAddress.length > 0 &&
    // Pubkey fields are read unconditionally by every mint / inscribe
    // path (`hex.decode(wallet.paymentPublicKey)` in the orchestrator's
    // simulation). Rehydrating a pre-schema payload without them
    // crashes with a bare `TypeError: Cannot read properties of
    // undefined` mid-simulation instead of forcing a clean reconnect
    // at load time. Require both, hex-shaped.
    isHex(o.paymentPublicKey) &&
    isHex(o.ordinalsPublicKey)
  );
}


/**
 * Cheap identity of the two wallet buckets for `distinctUntilChanged`:
 * only bucket membership (by wallet type) ever changes between
 * emissions, so this never touches the static per-wallet logo strings.
 */
function walletBucketKey(buckets: {
  installedWallets: KnownOrdinalWallet[];
  notInstalledWallets: KnownOrdinalWallet[];
}): string {
  return buckets.installedWallets.map((w) => w.type).join(',')
    + '||' + buckets.notInstalledWallets.map((w) => w.type).join(',');
}

/**
 * Stateful wallet-connection service (detect / connect / persist / account-
 * change / watch-only). Plain class: the consumer passes its storage
 * implementation + network to the constructor and owns the instance.
 * Reactivity is RxJS, so any consumer subscribes the same way.
 */
export class WalletService {

  private readonly storageService: StorageLike;
  readonly network: Network;

  walletConnectRequested$ = new Subject<boolean>();

  connectedWallet$ = new BehaviorSubject<WalletInfo | null>(null);
  wallets$ = timer(0, 500) // Start immediately and repeat every 500ms
    .pipe(
      take(4), // Take 4 intervals only, i.e., perform the check four times
      map(() => this.getInstalledWallets()),
      // Drop wallets flagged `hiddenFromPicker` (Phantom, Binance):
      // their DESKTOP binary is structurally incapable of driving the
      // SDK's flows, so they never belong in this desktop-detection
      // stream — not even the "install this wallet" list. The matrix
      // `platforms` list is the AUTHORITY for reachability, and
      // hiddenFromPicker is pinned to it (a wallet is hidden here IFF
      // the matrix marks it non-Desktop; wallet-capabilities.spec.ts
      // asserts the equivalence). A mobile-in-app picker instead reads
      // `walletsForPlatform(Mobile)`, where these two DO appear, and
      // ignores hiddenFromPicker.
      map(({ installedWallets, notInstalledWallets }) => ({
        installedWallets:    installedWallets.filter((w) => !w.hiddenFromPicker),
        notInstalledWallets: notInstalledWallets.filter((w) => !w.hiddenFromPicker),
      })),
      // The only thing that ever changes between emissions is WHICH
      // wallets are detected in each bucket; every wallet's metadata
      // (label, ~1.5-19 KB base64 logo data-URI) is static. Compare the
      // cheap type-membership of both buckets rather than JSON-stringify
      // the buckets (which would serialise ~40 KB of logo strings per
      // check, up to 3x per subscription).
      distinctUntilChanged((prev, curr) => walletBucketKey(prev) === walletBucketKey(curr))
    );

  // Static derivation from the network. Kept as a boolean field (read by
  // consumers that pick a mainnet-vs-testnet endpoint) and as a single-
  // emission Observable for legacy subscribers — neither ever changes after
  // construction; ordpool no longer routes a testnet UI. Assigned in the
  // constructor once `network` is known.
  readonly isMainnet: boolean;
  readonly isMainnet$: Observable<boolean>;

  /**
   * Coarse network group ('mainnet' | 'regtest' | 'testnet') the
   * consumer is configured against. Compared against the connected
   * wallet's address prefix to surface the "wrong network" red banner.
   */
  readonly expectedNetworkGroup: AddressNetworkGroup;

  /**
   * Emits `true` when the connected wallet's address prefix is
   * incompatible with the configured network. Consumers wire this
   * directly to a red-banner component. `false` when no wallet is
   * connected (nothing to compare against) AND when the prefix
   * matches the expected group.
   */
  readonly networkMismatch$: Observable<boolean>;

  /**
   * Last-seen unsubscribe handle returned by the active connector's
   * onAccountChange. Lives across reconnects; cleared on disconnect.
   */
  private accountChangeUnsubscribe: (() => void) | null = null;

  constructor(deps: { storage: StorageLike; network: Network }) {
    this.storageService = deps.storage;
    this.network = deps.network;

    this.isMainnet = this.network === Network.Mainnet;
    this.isMainnet$ = of(this.isMainnet);
    this.expectedNetworkGroup =
      this.network === Network.Mainnet ? 'mainnet'
        : this.network === Network.Regtest ? 'regtest'
          : 'testnet';
    this.networkMismatch$ = this.connectedWallet$.pipe(
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

    const raw = this.storageService.getValue(LAST_CONNECTED_WALLET);
    if (!raw) return;

    // JSON.parse throws on any malformed payload — truncation caused
    // by a browser storage-quota event, an out-of-app DevTools mis-
    // write, an older SDK format that predates the current shape, a
    // sync-corrupted transfer between browsers. Without the try/catch
    // the throw propagates out of the Angular DI constructor,
    // WalletService fails to instantiate, and every component that
    // injects it fails to render — the app is bricked with a white
    // page and no visible way to recover. Discard the corrupt entry
    // and behave as a first-time visitor: the user reconnects, no
    // support ticket.
    let info: WalletInfo | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isValidPersistedWalletInfo(parsed)) {
        info = parsed;
      } else {
        // eslint-disable-next-line no-console
        console.warn('[wallet.service] Discarding LAST_CONNECTED_WALLET with unrecognised shape:', parsed);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[wallet.service] Discarding malformed LAST_CONNECTED_WALLET:', err);
    }

    if (!info) {
      this.storageService.removeItem(LAST_CONNECTED_WALLET);
      return;
    }

    this.connectedWallet$.next(info);
    // Restore the event subscription so an account-switch fires
    // even if the user only refreshed the page.
    this.armAccountChangeSubscription(info.type);
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

  /**
   * Connect a watch-only wallet from a pasted account extended public
   * key (xpub / ypub / zpub / tpub / …). No signing key enters the
   * browser: the SDK derives the wallet's identity from the public key,
   * and the user signs each operation's PSBT in their own wallet
   * (Sparrow, Coldcard, Ledger, …) via the
   * export/paste bridge (`promptForSignedPsbt` on the operation calls).
   *
   * Derives the receive window and auto-picks the active identity by
   * probing on-chain state, because a cat can sit at any derivation
   * index (the Genesis Cat is not necessarily at index 0). The `probe`
   * callback is consumer-wired to electrs (+ the cat index): the SDK
   * owns the derive + rank, the consumer owns the I/O, so all three
   * consumer sites share one identical derivation and auto-pick.
   *
   * v1 identity model is single-account Taproot (the same model OKX
   * proves in this codebase). `scriptType` is required only for a
   * script-type-ambiguous prefix (plain xpub/tpub — pass `p2tr` for a
   * taproot account); SLIP-132 prefixes (ypub/zpub/…) imply it.
   *
   * Emits the assembled `WalletInfo` and pushes it to
   * `connectedWallet$`, exactly like `connectWallet`, so every existing
   * consumer flow treats a watch-only wallet like any other connected
   * wallet. Account-change arming is a no-op (there is no injected
   * provider to subscribe to).
   */
  connectXpub(args: {
    extendedPublicKey: string;
    scriptType?: WatchOnlyScriptType;
    gapLimit?: number;
    probe: (address: string) => Promise<AddressProbe>;
    /**
     * Override the auto-picked identity from the scanned window. Use it to
     * show the user the scan, let them choose a different funding/ordinals
     * address, and connect with that choice in ONE call (no re-scan). The
     * addresses MUST come from `scan.scanned` (derived from the same account
     * key) so the identity is never an on-chain-lookup value. Omit for the
     * default auto-pick (cat-bearing / highest-funded).
     */
    pickIdentity?: (scan: WatchOnlyScanResult) => { ordinals: WatchOnlyAddress; payment: WatchOnlyAddress };
  }): Observable<WalletInfo> {
    return from(scanWatchOnly({
      extendedPublicKey: args.extendedPublicKey,
      network: this.network,
      scriptType: args.scriptType,
      gapLimit: args.gapLimit,
      probe: args.probe,
    })).pipe(
      switchMap((scan) => {
        const pick = args.pickIdentity
          ? args.pickIdentity(scan)
          : { ordinals: scan.ordinals, payment: scan.payment };
        return this.connectFromScan(scan, pick);
      }),
    );
  }

  /**
   * Connect a watch-only wallet from an ALREADY-COMPLETED scan and a chosen
   * identity: the second half of {@link connectXpub}, split out so a consumer
   * can run an INTERACTIVE review between scan and connect (scan, show the
   * auto-picked addresses, let the user override the funding/ordinals address,
   * then connect the confirmed pick) without re-scanning or re-implementing
   * the `WalletInfo` assembly — the exact place the ordinals/payment split
   * drifts if each consumer hand-rolls it.
   *
   * The chosen addresses MUST come from `scan.scanned` (derived from the same
   * account key), so a watch-only identity is never an on-chain-lookup value.
   * Emits an error if either address is absent from the scan.
   *
   * Assembles the `WalletInfo`, persists it, and pushes it to
   * `connectedWallet$`, exactly like `connectXpub` / `connectWallet`.
   */
  connectFromScan(
    scan: WatchOnlyScanResult,
    identity: { ordinals: WatchOnlyAddress; payment: WatchOnlyAddress },
  ): Observable<WalletInfo> {
    return defer(() => {
      const scanned = new Set(scan.scanned.map(s => s.address.address));
      if (!scanned.has(identity.ordinals.address) || !scanned.has(identity.payment.address)) {
        return throwError(() => new Error(
          'connectFromScan: chosen ordinals/payment addresses must come from scan.scanned',
        ));
      }
      const info: WalletInfo = {
        type: KnownOrdinalWalletType.xpub,
        ordinalsAddress: identity.ordinals.address,
        ordinalsPublicKey: identity.ordinals.publicKeyHex,
        paymentAddress: identity.payment.address,
        paymentPublicKey: identity.payment.publicKeyHex,
        // The watch-only signer (psbtExportSigner) ships, so mint flows that
        // gate on this proceed to the export/paste bridge.
        signingSupported: true,
      };
      this.storageService.setValue(LAST_CONNECTED_WALLET, JSON.stringify(info));
      this.connectedWallet$.next(info);
      this.armAccountChangeSubscription(info.type);
      return of(info);
    });
  }

  disconnectWallet(): void {
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
   * Address-drift protection (finding #11 fix, 2026-07-25). Some
   * wallets' `signMessage` API takes no address arg and just signs
   * under whatever the wallet's UI currently has selected (Unisat,
   * Leather, others). If the user account-switches between the
   * caller reading `wallet.ordinalsAddress` and the wallet actually
   * signing, the returned sig is a valid BIP-322 sig against a
   * different key — every downstream verify (backend session guard,
   * orderbook listing verify) fails with a confusing error even
   * though the wallet reported success.
   *
   * Two gates catch the drift:
   *
   *   1. Pre-dispatch: `input.address` MUST match the currently-
   *      cached `wallet.ordinalsAddress`. If not, throw before
   *      calling the signer — no wallet round-trip wasted.
   *
   *   2. Post-verify: after the signer returns, verify the sig
   *      against `input.address` using the SDK's BIP-322 primitive.
   *      Catches the case where the cache was right but the wallet
   *      itself signed with a different key (user switched inside
   *      the wallet UI mid-request). ~1 ms schnorr, cheap.
   *
   * Used by the CAT-21 orderbook flow to prove seller ownership,
   * by the session-token capability layer for marketplace mutations,
   * and by any future BIP-322 auth surface.
   */
  signMessage(input: SignMessageArgs): Observable<SignMessageResult> {
    const wallet = this.connectedWallet$.getValue();
    if (!wallet) {
      return new Observable<SignMessageResult>((observer) => {
        observer.error(new Error('No wallet connected'));
      });
    }
    if (wallet.ordinalsAddress !== input.address) {
      return new Observable<SignMessageResult>((observer) => {
        observer.error(new Error(
          `signMessage: caller-requested address ${input.address} does not match ` +
          `the connected wallet's ordinals address ${wallet.ordinalsAddress}. ` +
          `Reconnect the intended wallet and retry.`,
        ));
      });
    }
    return findSignerOrThrow(wallet.type).signMessage(input).pipe(
      map((result) => {
        const verify = verifyBip322Signature({
          address: input.address,
          message: input.message,
          signatureBase64: result.signature,
        });
        if (verify.ok === true) {
          return result;
        }
        throw new Error(
          `signMessage: returned signature does not verify against ${input.address} ` +
          `(reason: ${verify.reason}). The wallet may have signed under a different ` +
          `account than the one you connected; reconnect the intended account and retry.`,
        );
      }),
    );
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
    // Soft lookup — a stale LAST_CONNECTED_WALLET pointing at a wallet
    // whose connector was retired (e.g. `binance` after it left the
    // roster) would otherwise throw synchronously in the constructor
    // and wedge Angular DI on hard reload with no recovery path. If the
    // connector is gone, silently skip re-arming; the cached wallet
    // stays in place until the user explicitly disconnects.
    const connector = walletConnectors.find(c => c.providerId === type);
    if (!connector || !connector.onAccountChange) return;
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
