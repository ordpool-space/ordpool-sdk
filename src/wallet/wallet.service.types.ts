import { Observable } from 'rxjs';
import { AddressPurpose } from 'sats-connect';

import { Network } from '../network';


/**
 * Minimal shape of `window` for wallet detection. Real browser
 * extensions inject these properties; in tests we pass a stub
 * object with whatever subset we want present.
 */
export interface WindowLike {
  XverseProviders?: unknown;
  LeatherProvider?: unknown;
  HiroWalletProvider?: unknown;
  unisat?: unknown;
  wizz?: unknown;
  atom?: unknown;            // wizz's legacy namespace (formerly Atom Wallet)
  okxwallet?: unknown;
  phantom?: unknown;
  oyl?: unknown;
  alby?: unknown;
  webln?: unknown;           // alby's standard Lightning provider name
  binancew3w?: unknown;      // Binance Web3 Wallet multi-chain namespace
  /**
   * CAT-21 wallet — our own Bitcoin L1 wallet, forked from Leather.
   * Per the wallet's INTEGRATION-ORDPOOL-SDK contract this slot is
   * ALWAYS present when CAT-21 wallet is installed AND the provider
   * carries `isCat21: true`. The wallet's politeness model also fills
   * `window.LeatherProvider` only if real Leather is NOT installed,
   * so we never identify CAT-21 wallet from the Leather slot —
   * `isLeatherInstalled` filters out `isCat21` providers.
   */
  Cat21Provider?: unknown;
  /** WBIP004 multi-wallet registry. CAT-21 wallet pushes an entry here too. */
  btc_providers?: unknown;
}


/**
 * A wallet connector handles the READ side of a wallet integration:
 * detect whether the wallet is installed, then connect to it to
 * retrieve the user's addresses. Sign-side lives in `signers/`.
 *
 * Each connector is a pure object — no DI dependency, no class
 * instantiation. The `WalletService` holds a registry of these.
 */
export interface WalletConnector {
  readonly providerId: KnownOrdinalWalletType;
  readonly wallet: KnownOrdinalWallet;
  /** True if a matching `WalletSigner` exists in `signers/` for this wallet. */
  readonly signingSupported: boolean;
  detect(win: WindowLike | undefined): boolean;
  connect(network: Network): Observable<WalletInfo>;
  /**
   * Subscribe to in-wallet account-or-network changes. Returns an
   * unsubscribe function. Consumers call this AFTER `connect()` to
   * be notified when the user switches accounts or networks inside
   * the wallet's own UI; the standard reaction is to invalidate any
   * cached address/publicKey and re-run `connect()` (or abort an
   * in-flight mint/transfer/offer flow).
   *
   * Optional because not every wallet exposes events. When the
   * method is absent, consumers MUST defend against stale-cache
   * poisoning by re-running `connect()` at sign-time and asserting
   * the address still matches what they intend to sign over.
   */
  onAccountChange?(handler: () => void): () => void;
}


/**
 * Inputs for {@link WalletSigner.signAndBroadcast}. The signer
 * receives an unsigned PSBT, asks the wallet to sign it, and
 * eventually emits a txid. Wallets handle the steps differently:
 *
 * - **Xverse / Unisat**: sign and broadcast atomically in one user
 *   dialog. They emit the txid directly; `broadcast` is unused.
 * - **Leather**: signs the PSBT and returns it. The signer finalizes
 *   via scure and then delegates broadcasting back to the caller
 *   via the `broadcast` callback — the caller owns the mempool API
 *   (electrs `POST /tx` via the configured HttpClient).
 * - **PSBT-export (Sparrow / Electrum / Coldcard / Ledger / Trezor /
 *   …)**: signing happens out-of-band in the user's own wallet
 *   software. The signer hands the unsigned PSBT to
 *   `promptForSignedPsbt`, which is responsible for showing a
 *   download / paste UI and emitting the signed PSBT back when the
 *   user is done. Then finalise via scure and call `broadcast`.
 *
 * Passing the bridges as parameters keeps signers free of HTTP and
 * DOM dependencies while still letting the contract be "PSBT in,
 * txid out" for every wallet uniformly.
 */
/**
 * One row of the signingMap: "sign these specific input indexes
 * with the private key behind this address". Multiple rows ⇒
 * multi-address signing (transfer: ordinals address on input 0,
 * payment address on funding inputs; offer-accept: ordinals
 * address on input 0 only).
 *
 * For wallets whose RPC takes one address+indexes pair per call
 * (Xverse, Unisat, Phantom, Oyl, OKX, Wizz): the signer maps
 * directly to the wallet's per-pair array shape.
 *
 * For single-index wallets (Leather, cat21-wallet): the signer
 * iterates the rows, calling signPsbt once per (address, index)
 * pair, threading the partially-signed PSBT through each call.
 */
export interface PsbtSigningTarget {
  address: string;
  indexes: number[];
  /** SIGHASH override per-row. Defaults to SIGHASH_ALL on every cat-flow we ship today. */
  sigHash?: number;
}

export interface SignAndBroadcastInput {
  psbtBytes: Uint8Array;
  /**
   * The wallet's payment address. Always required (we broadcast
   * via electrs and several signer APIs want the address as a label).
   *
   * Historical: was the only signing address back when mint was the
   * only flow. New flows (transfer, offer) supply `signingMap`
   * additionally to drive multi-address signing.
   */
  paymentAddress: string;
  /**
   * Which inputs each address signs. Optional; defaults to
   * `[{ address: paymentAddress, indexes: [0] }]` to keep the
   * legacy mint call shape working unchanged.
   *
   * For a transfer (cat input at ordinals + funding at payment):
   *   `[{ address: ordinalsAddress, indexes: [0] },
   *     { address: paymentAddress,  indexes: [1, 2, …] }]`
   * For a buyer-side offer create (buyer signs only their funding
   * inputs at payment; seller's cat input at index 0 stays unsigned):
   *   `[{ address: paymentAddress, indexes: [1, 2, …] }]`
   * For a seller-side offer accept (seller signs only the cat input
   * at the ordinals address, every funding input is already buyer-signed):
   *   `[{ address: ordinalsAddress, indexes: [0] }]`
   *
   * Order matters for single-index wallets (Leather, cat21-wallet)
   * because each call returns a partially-signed PSBT that's threaded
   * into the next call. Multi-index wallets (Xverse) honour the array
   * as a whole.
   */
  signingMap?: ReadonlyArray<PsbtSigningTarget>;
  network: Network;
  /** Broadcast a finalized tx-hex. Returns the txid. */
  broadcast(txHex: string): Observable<string>;
  /**
   * Bridge to a user-mediated sign step. Required for watch-only
   * signers (xpub-based wallets that can't sign inside the browser);
   * browser-wallet signers (Xverse, Leather, Unisat) ignore it.
   *
   * The callback receives the unsigned PSBT (already encoded as
   * base64 and hex for UI convenience) and emits the signed PSBT
   * as a base64 string. Accepting hex back too is the signer's
   * responsibility; the prompt only needs to return one shape.
   */
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/**
 * A wallet signer handles the SIGN side of a wallet integration:
 * given an unsigned PSBT, ask the wallet to sign, and emit a txid
 * once it's broadcast. Sign roster is broad per CLAUDE.md
 * "Ship every signer we have code for" — detect-by-signature
 * gates surface visibility, so signer code that ships against a
 * wallet without a runtime API surface is just dormant rather
 * than harmful.
 *
 * Generic against the PSBT (not cat21-specific). Used by
 * `Cat21Service` today; future inscription-creation / rune-etch /
 * generic-send features will share the same signer registry.
 */
export interface WalletSigner {
  readonly providerId: KnownOrdinalWalletType;
  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }>;
}

export enum KnownOrdinalWalletType {
  xverse = 'xverse',
  leather = 'leather',
  unisat = 'unisat',
  wizz = 'wizz',
  okx = 'okx',
  phantom = 'phantom',
  oyl = 'oyl',
  alby = 'alby',
  binance = 'binance',
  /**
   * CAT-21 wallet — our own Bitcoin-L1 wallet, forked from Leather.
   * The maintainer ships this one. Provider lives at
   * `window.Cat21Provider` (with `isCat21: true`) per
   * INTEGRATION-ORDPOOL-SDK.md in the cat21-wallet repo. Wire
   * protocol matches Leather's Bitcoin RPC subset
   * (getAddresses / signPsbt / etc.) so the connector + signer
   * shape mirrors Leather's. Stacks methods are stripped.
   */
  cat21wallet = 'cat21wallet',
  /**
   * Watch-only via BIP-32 xpub paste. Covers Sparrow, Electrum,
   * Coldcard, Ledger, Trezor, Specter, Bitcoin Core — every desktop
   * or hardware wallet that doesn't inject into the browser but
   * speaks PSBT and exports an xpub.
   */
  xpub = 'xpub',
}

export interface KnownOrdinalWallet {
  type: KnownOrdinalWalletType;
  label: string;
  subLabel?: string;
  logo: string;
  downloadLink: string;
  /**
   * Whether this wallet can hold on-chain ordinal artifacts
   * (inscriptions, CAT-21 sats, runes, etc.) at all. Defaults to
   * `true` when omitted; `false` for Lightning-/Nostr-only wallets
   * whose detection succeeds but whose addresses can't carry sats
   * the consumer cares about. Consumers building strictly ordinals-
   * focused pickers (cat21.space) filter these out; consumers with
   * Lightning surfaces (future ordpool Lightning support, Alby for
   * webln) leave them in.
   */
  onChainOrdinals?: boolean;
}

import { walletLogos } from './wallet-logos';

export const KnownOrdinalWallets: { [K in KnownOrdinalWalletType]: KnownOrdinalWallet } = {
  [KnownOrdinalWalletType.xverse]: {
    type: KnownOrdinalWalletType.xverse,
    label: 'Xverse',
    logo: walletLogos.xverse,
    downloadLink: 'https://www.xverse.app/download'
  },
  [KnownOrdinalWalletType.leather]: {
    type: KnownOrdinalWalletType.leather,
    label: 'Leather',
    logo: walletLogos.leather,
    // Was /install-extension, but that path now 404s — Leather archived it
    // (leather.io/install redirects to /old-page/install-extension).
    // Homepage is the stable CTA.
    downloadLink: 'https://leather.io/'
  },
  [KnownOrdinalWalletType.unisat]: {
    type: KnownOrdinalWalletType.unisat,
    label: 'Unisat',
    // subLabel: '(not fully supported)',
    logo: walletLogos.unisat,
    downloadLink: 'https://unisat.io/download'
  },
  [KnownOrdinalWalletType.wizz]: {
    type: KnownOrdinalWalletType.wizz,
    label: 'Wizz',
    logo: walletLogos.wizz,
    downloadLink: 'https://wizzwallet.io/',
  },
  [KnownOrdinalWalletType.okx]: {
    type: KnownOrdinalWalletType.okx,
    label: 'OKX',
    logo: walletLogos.okx,
    downloadLink: 'https://web3.okx.com/download',
  },
  [KnownOrdinalWalletType.phantom]: {
    type: KnownOrdinalWalletType.phantom,
    label: 'Phantom',
    logo: walletLogos.phantom,
    downloadLink: 'https://phantom.com/download',
  },
  [KnownOrdinalWalletType.oyl]: {
    type: KnownOrdinalWalletType.oyl,
    label: 'Oyl',
    logo: walletLogos.oyl,
    downloadLink: 'https://oyl.io/',
  },
  [KnownOrdinalWalletType.alby]: {
    type: KnownOrdinalWalletType.alby,
    label: 'Alby',
    subLabel: 'Lightning + Nostr (not on-chain ordinals)',
    logo: walletLogos.alby,
    downloadLink: 'https://getalby.com/',
    onChainOrdinals: false,
  },
  [KnownOrdinalWalletType.binance]: {
    type: KnownOrdinalWalletType.binance,
    label: 'Binance Wallet',
    subLabel: 'API documented but not exposed in v1.17.2 — surfaces only if Binance enables it',
    logo: walletLogos.binance,
    downloadLink: 'https://www.binance.com/en/web3wallet',
  },
  [KnownOrdinalWalletType.cat21wallet]: {
    type: KnownOrdinalWalletType.cat21wallet,
    label: 'CAT-21 wallet',
    subLabel: 'Our own — hot wallet for active cat trading. BTC L1 mainnet.',
    logo: walletLogos.cat21wallet,
    downloadLink: 'https://github.com/ordpool-space/cat21-wallet',
  },
  [KnownOrdinalWalletType.xpub]: {
    type: KnownOrdinalWalletType.xpub,
    label: 'Watch-only (xpub)',
    subLabel: 'Sparrow, Electrum, Coldcard, Ledger, Trezor, …',
    logo: walletLogos.xpub,
    downloadLink: '',
  },
};

export interface WalletInfo {
  type: KnownOrdinalWalletType;

  ordinalsAddress: string;
  ordinalsPublicKey: string;

  paymentAddress: string;
  paymentPublicKey: string;

  /**
   * Whether ordpool ships a tested `WalletSigner` for this wallet.
   * Read flows ignore it; mint flows gate on it. See `signers/`.
   */
  signingSupported: boolean;
}


export interface XverseAddressResponse {
  addresses: {
    address: string,
    publicKey: string,
    purpose: AddressPurpose.Ordinals | AddressPurpose.Payment
  }[];
}

export interface LeatherAddressResponse {
  jsonrpc: string;
  id: string;
  result: {
    addresses: LeatherAddress[];
  };
}

export type LeatherAddress = LeatherBtcAddress | LeatherStxAddress;

export interface LeatherBtcAddress {
  symbol: 'BTC';
  type: string;
  address: string;
  publicKey: string;
  derivationPath: string;
  tweakedPublicKey?: string;
}

export interface LeatherStxAddress {
  symbol: 'STX';
  address: string;
}
