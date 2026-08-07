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
export interface SignAndBroadcastInput {
  psbtBytes: Uint8Array;
  paymentAddress: string;
  /** See `SignSingleFundingInputArgs.paymentPublicKey`. Optional. */
  paymentPublicKey?: string;
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
 * One row of the signingMap: "sign these specific input indexes
 * with the private key behind this address". Multiple rows ⇒
 * multi-address signing.
 *
 * For wallets whose RPC takes one address+indexes pair per call
 * (Xverse, Phantom, Unisat with toSignInputs, Binance): the
 * signer maps directly to the wallet's per-pair array shape.
 *
 * For single-index wallets (Leather, cat21-wallet): the signer
 * iterates the rows, calling signPsbt once per (address, index)
 * pair, threading the partially-signed PSBT through each call.
 */
export interface PsbtSigningTarget {
  address: string;
  indexes: number[];
  /** Per-row SIGHASH override. Defaults to SIGHASH_ALL on every cat-flow we ship today. */
  sigHash?: number;
}

/**
 * Input shape for `signMultiInputAndBroadcast` — the multi-address
 * signing variant used by transfer and offer flows where the user
 * signs across BOTH the ordinals address (cat input at index 0) AND
 * the payment address (funding inputs at indexes 1+). See
 * `PsbtSigningTarget` for the per-row contract.
 *
 * Concrete shapes by flow:
 *
 *   transfer: [
 *     { address: ordinalsAddress, indexes: [0] },
 *     { address: paymentAddress,  indexes: [1, 2, …] },
 *   ]
 *   offer-create (buyer): [
 *     { address: paymentAddress, indexes: [1, 2, …] },
 *   ]
 *   offer-accept (seller): [
 *     { address: ordinalsAddress, indexes: [0] },
 *   ]
 *
 * Order matters for single-index wallets (Leather, cat21-wallet):
 * each `signPsbt` call returns a partially-signed PSBT threaded into
 * the next call. Multi-index wallets honour the array as a whole.
 */
export interface SignMultiInputAndBroadcastInput {
  psbtBytes: Uint8Array;
  signingMap: ReadonlyArray<PsbtSigningTarget>;
  /** See `SignSingleFundingInputArgs.paymentPublicKey`. Optional. */
  paymentPublicKey?: string;
  network: Network;
  /** Broadcast a finalized tx-hex. Returns the txid. */
  broadcast(txHex: string): Observable<string>;
  /** Mirrors SignAndBroadcastInput.promptForSignedPsbt for watch-only signers. */
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/**
 * Input shape for `signPsbtOnly` — buyer-side offer-create. The PSBT
 * is signed at the addresses + indexes in `signingMap` and returned as
 * raw partial-sig PSBT bytes. NO broadcast — the buyer's signed PSBT
 * is incomplete by design (seller's cat input at index 0 stays
 * unsigned). The buyer ships those bytes as the offer artifact; the
 * seller signs input 0 and broadcasts via `signMultiInputAndBroadcast`.
 *
 * The returned bytes are still in PSBT format (not wire-format tx) —
 * they carry buyer partial sigs but no `finalScriptWitness` for input
 * 0. `validateCat21BuyOfferPsbt` reads them directly.
 */
export interface SignPsbtOnlyInput {
  psbtBytes: Uint8Array;
  signingMap: ReadonlyArray<PsbtSigningTarget>;
  /** See `SignSingleFundingInputArgs.paymentPublicKey`. Optional. */
  paymentPublicKey?: string;
  network: Network;
  /** Mirrors SignAndBroadcastInput.promptForSignedPsbt for watch-only signers. */
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/**
 * Single-input mint / inscribe-commit / RBF / CPFP-child shape.
 * The PSBT has exactly one input at `paymentAddress`, SIGHASH_ALL.
 * The signer asks the wallet to sign that one input, finalizes,
 * broadcasts via the caller's callback.
 */
export interface SignSingleFundingInputArgs {
  psbtBytes: Uint8Array;
  paymentAddress: string;
  /**
   * Optional; enables the Unisat/Wizz/OKX wallet-side address
   * shim on regtest. When set + the app's `paymentAddress` is bcrt,
   * the signer derives the wallet's mainnet-view of the same key
   * (script bytes identical) and passes THAT in the sign RPC's
   * per-input address filter. Mainnet-only wallets refuse to open
   * their sign popup when the address isn't in their address set,
   * so this field is load-bearing for cross-network signing.
   */
  paymentPublicKey?: string;
  network: Network;
  broadcast(txHex: string): Observable<string>;
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/**
 * Transfer shape — input 0 = cat UTXO at `ordinalsAddress`, inputs
 * 1..`fundingInputCount` = funding UTXOs at `paymentAddress`, all
 * SIGHASH_ALL. Topology is fixed by ordinal-theory FIFO + the
 * cat-flow HARD RULE (cat at input 0). Caller (orchestrator) only
 * states how many funding inputs the same builder put after the cat.
 */
export interface SignTransferArgs {
  psbtBytes: Uint8Array;
  ordinalsAddress: string;
  paymentAddress: string;
  /** Number of funding inputs at paymentAddress, positioned at indexes 1..count. */
  fundingInputCount: number;
  network: Network;
  broadcast(txHex: string): Observable<string>;
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/**
 * Offer-accept (seller) shape — input 0 = the seller's cat UTXO at
 * `ordinalsAddress`, SIGHASH_ALL. All other inputs are buyer-signed
 * and MUST NOT be touched. The signer must restrict its own call to
 * input 0 exactly.
 */
export interface SignOfferAcceptArgs {
  psbtBytes: Uint8Array;
  ordinalsAddress: string;
  network: Network;
  broadcast(txHex: string): Observable<string>;
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/**
 * Offer-create (buyer) shape — input 0 = seller's cat placeholder
 * (untouched), inputs 1..`fundingInputCount` = buyer's funding UTXOs
 * at `paymentAddress`, all SIGHASH_ALL. Returns the partial-sig
 * PSBT bytes (the buy-offer artifact); no broadcast.
 */
export interface SignOfferCreatePsbtArgs {
  psbtBytes: Uint8Array;
  paymentAddress: string;
  /** Number of buyer funding inputs at paymentAddress, positioned at indexes 1..count. */
  fundingInputCount: number;
  network: Network;
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/**
 * BIP-322 message signing — off-chain, no PSBT, no broadcast. Used
 * by the CAT-21 orderbook to prove "this wallet controls this
 * ordinals address" without moving any sats. The message the seller
 * signs is the canonical `buildListingMessage(...)` output; the
 * server verifies via `verifyListingSignature(...)`.
 *
 * Different call-shape from the PSBT signers: no bytes to hand off,
 * just an address + a string. Every major Bitcoin extension wallet
 * exposes a `signMessage`-shaped RPC that emits a BIP-322 base64
 * signature witness. Wallets that don't (or that focus on Lightning
 * / non-Bitcoin flows) error with a clear "not supported" message.
 */
export interface SignMessageArgs {
  /**
   * The address whose key should sign — for BIP-322 P2TR this is
   * the ordinals address (where cats live per ordinal theory).
   * The signer maps this to whichever wallet-side "sign under this
   * key" API the wallet exposes.
   */
  address: string;
  /** UTF-8 message to sign. Wallet renders this to the user for approval. */
  message: string;
  /** Bitcoin network — used for the wallet's network-mismatch check. */
  network: Network;
}

export interface SignMessageResult {
  /**
   * Base64-encoded BIP-322 "simple" signature witness. Wallet-format-
   * dependent: some return raw 64/65-byte schnorr sigs, some wrap in
   * a serialized witness stack (`numItems || sigLen || sigBytes`).
   * `verifyListingSignature` accepts both shapes.
   */
  signature: string;
}

/**
 * A wallet signer handles the SIGN side of a wallet integration:
 * given an unsigned PSBT for a known on-chain operation, ask the
 * wallet to sign the inputs at the operation's fixed topology, and
 * emit a txid (or partial-sig PSBT for offer-create) once broadcast.
 *
 * # Topology is NOT configurable.
 *
 * Every method's signing positions are HARDCODED for one operation:
 *
 *   - `signSingleFundingInput`: 1 input at paymentAddress, SIGHASH_ALL
 *     (mint, inscribe-commit, RBF replacement, CPFP child).
 *   - `signTransfer`: input 0 = ordinalsAddress, inputs 1..N = paymentAddress.
 *   - `signOfferAccept`: input 0 = ordinalsAddress; nothing else.
 *   - `signOfferCreatePsbt`: inputs 1..N = paymentAddress; input 0 untouched.
 *
 * No caller can ask for a non-topology shape. No "signingMap"
 * primitive exists anymore.
 *
 * Sign roster is broad per CLAUDE.md "Ship every signer we have
 * code for" — detect-by-signature gates surface visibility, so
 * signer code that ships against a wallet without a runtime API
 * surface is just dormant rather than harmful.
 *
 * # `signOfferCreatePsbt` and watch-only signers.
 *
 * Buyer-side offer-create produces a sign-only-no-broadcast PSBT.
 * Signers that can't do sign-without-broadcast throw with a clear
 * message; the consumer steers the user to a compatible wallet
 * (xverse / cat21-wallet / leather / unisat / psbt-export today).
 */
export interface WalletSigner {
  readonly providerId: KnownOrdinalWalletType;

  signSingleFundingInput(input: SignSingleFundingInputArgs): Observable<{ txId: string }>;
  signTransfer(input: SignTransferArgs): Observable<{ txId: string }>;
  signOfferAccept(input: SignOfferAcceptArgs): Observable<{ txId: string }>;
  signOfferCreatePsbt(input: SignOfferCreatePsbtArgs): Observable<Uint8Array>;
  /**
   * Sign a UTF-8 message under an ordinals key via BIP-322.
   * Wallets without a BIP-322 RPC surface return an error observable.
   */
  signMessage(input: SignMessageArgs): Observable<SignMessageResult>;
}

/**
 * Internal-only contract that `operationNamedDefaults` accepts.
 * Each signer file holds a closure-scoped object satisfying this
 * shape so the new operation-named methods can delegate to a single
 * wallet-RPC implementation per topology. NEVER exported from
 * `core.ts` / `index.ts`; NEVER spread onto the exported signer
 * object — that's how we make the signingMap-shaped methods
 * structurally impossible to reach from outside the file.
 */
export interface WalletSignerInternalImpls {
  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }>;
  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }>;
  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array>;
}

export enum KnownOrdinalWalletType {
  xverse = 'xverse',
  leather = 'leather',
  unisat = 'unisat',
  wizz = 'wizz',
  okx = 'okx',
  phantom = 'phantom',
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
   * When `true`, `WalletService.wallets$` drops this wallet from BOTH
   * `installedWallets` AND `notInstalledWallets` — the wallet
   * disappears from every consumer's picker AND from every "install
   * this wallet" list.
   *
   * Use this ONLY when the wallet's shipped binary is structurally
   * incapable of driving the SDK's inscribe / CAT-21 flows — either
   * the required in-page provider surface isn't injected (Binance
   * v1.17.2 omits `window.binancew3w.bitcoin`) or the service worker
   * doesn't implement the required RPC methods (Phantom v26.x has no
   * `btc_*` handlers). Offering a wallet as "installable" when
   * installing it still leaves the user unable to sign is a lie.
   *
   * The connector + signer files stay in the SDK — the day the
   * vendor ships the missing surface, flip this back to `false`
   * (or delete) and the wallet lights up automatically.
   */
  hiddenFromPicker?: boolean;
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
    // Phantom v26.14.0+ ships `btc.js` as an inpage script but never
    // registers it as a content script, AND the SW rejects
    // `btc_requestAccounts` with "isn't implemented". Positively
    // pinned by phantom-mint-connect-blocked.spec.ts +
    // phantom-inscribe-connect-blocked.spec.ts +
    // phantom-sdk-handshake.spec.ts:370-476. Hidden until Phantom
    // wires the SW handlers.
    hiddenFromPicker: true,
  },
  [KnownOrdinalWalletType.alby]: {
    type: KnownOrdinalWalletType.alby,
    label: 'Alby',
    logo: walletLogos.alby,
    downloadLink: 'https://getalby.com/',
  },
  [KnownOrdinalWalletType.binance]: {
    type: KnownOrdinalWalletType.binance,
    label: 'Binance Wallet',
    logo: walletLogos.binance,
    downloadLink: 'https://www.binance.com/en/web3wallet',
    // Binance Web3 Wallet v1.17.2 (disassembled 2026-06-12) injects
    // only window.binancew3w.{wallet, ethereum, solana, tron, sui,
    // tonconnect} — the documented .bitcoin sub-provider that our
    // connector + signer target isn't wired. Detection returns false
    // on real installs; this wallet's connector + signer + registry
    // entry all ship (per the "ship every signer" HARD RULE) but the
    // wallet is hidden from consumer pickers until Binance enables
    // the documented surface. See honest-wallet-coverage.spec.ts's
    // WALLETS_WITHOUT_PIPELINE_B carve-out for the full trail.
    hiddenFromPicker: true,
  },
  [KnownOrdinalWalletType.cat21wallet]: {
    type: KnownOrdinalWalletType.cat21wallet,
    label: 'CAT-21 wallet',
    subLabel: 'Our own hot wallet for active cat trading.',
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
