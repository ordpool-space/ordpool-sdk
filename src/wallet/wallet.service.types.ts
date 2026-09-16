import { Observable } from 'rxjs';
import { AddressPurpose } from 'sats-connect';

import { Network } from '../network';


/**
 * Minimal shape of `window` for wallet detection. Real browser
 * extensions inject these properties; in tests we pass a stub
 * object with whatever subset we want present.
 */
export interface WindowLike {
  /**
   * Read only to tell a phone from a desktop. A wallet is reachable on
   * mobile through its own in-app browser, which is a property of the
   * device, not of the window size.
   */
  navigator?: { userAgent?: string; maxTouchPoints?: number; platform?: string };
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
 *   (electrs `POST /tx` via the caller's own `fetch`).
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
  /**
   * Per-row public key (hex) used by the address-filter signers
   * (Unisat/Wizz/OKX) to compute the wallet-side (mainnet) address for
   * this row's `toSignInputs` filter. Defaults to the flow's
   * `paymentPublicKey`. Set it when a row signs at an address derived
   * from a DIFFERENT key than the payment key — e.g. the child reveal's
   * parent input, which is a Taproot key-path at the ordinals address
   * (derived from the ordinals pubkey, not the payment pubkey). Ignored
   * by index-based signers (Leather / cat21-wallet) that sign by
   * position off the PSBT rather than by an address filter.
   */
  publicKey?: string;
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
 * The inscribe commit for a chosen sat less than a dust limit into its UTXO
 * (ord's `pad_alignment_output`): a padding payment input goes first.
 *
 *   without `ordinalsAddress`  [padding, funding holding the sat]  both at paymentAddress
 *   with `ordinalsAddress`     [padding, satSource, funding]        0 and 2 at paymentAddress, 1 at ordinalsAddress
 *
 * SIGHASH_ALL (DEFAULT on taproot) on each; broadcast after signing.
 */
export interface SignPaddedSatCommitArgs {
  psbtBytes: Uint8Array;
  paymentAddress: string;
  /** Set when the chosen sat is in a satSource UTXO at this address (input 1). */
  ordinalsAddress?: string;
  network: Network;
  broadcast(txHex: string): Observable<string>;
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/** The input indexes each address signs in a padded-sat commit; see {@link SignPaddedSatCommitArgs}. */
export function paddedSatCommitSigningPositions(
  input: Pick<SignPaddedSatCommitArgs, 'paymentAddress' | 'ordinalsAddress'>,
): Array<{ address: string; indexes: number[] }> {
  return input.ordinalsAddress !== undefined
    ? [{ address: input.paymentAddress, indexes: [0, 2] }, { address: input.ordinalsAddress, indexes: [1] }]
    : [{ address: input.paymentAddress, indexes: [0, 1] }];
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
  /**
   * The seller's ordinals x-only (or 33-byte) pubkey hex — the internal key
   * of the Taproot cat input 0. Address-filter signers use it to shim the
   * wallet-side address; the Xverse override also injects it as input 0's
   * `tapInternalKey` on the bare wallet-facing PSBT (see
   * `prepareOfferAcceptWalletFacing`).
   */
  ordinalsPublicKey: string;
  network: Network;
  broadcast(txHex: string): Observable<string>;
  promptForSignedPsbt?(unsigned: { base64: string; hex: string }): Observable<string>;
}

/**
 * Child-inscribe reveal (ord parent/child) shape. The reveal PSBT already
 * has the child's COMMIT input ephemeral-finalized; the wallet signs the
 * PARENT inscription input at index 0 (P2TR key-path at the ordinals
 * address — the key that owns the parent), then the tx is finalized +
 * broadcast. Same one-ordinals-input topology as `signOfferAccept`.
 */
export interface SignChildRevealParentInputsArgs {
  /**
   * The reveal PSBT the WALLET signs. Input 1 is a BARE Taproot input
   * (no envelope tap-leaf), so every wallet's signPsbt handles it — some
   * hang or reject a PSBT carrying a non-standard tap-leaf on an input
   * they aren't asked to sign. The wallet signs input 0 (the parent).
   */
  psbtBytes: Uint8Array;
  /**
   * The FULL reveal PSBT (input 1 carries the ephemeral tapScriptSig +
   * envelope tapLeafScript). The wallet's input-0 signature is merged onto
   * this, then BOTH inputs finalize and the wire tx broadcasts. Input 0's
   * signature is valid here because its sighash commits to input 1's
   * prevout, not the PSBT metadata that differs between the two.
   */
  finalizePsbtBytes: Uint8Array;
  /** The parent inscription's address — where it lives + returns to. */
  ordinalsAddress: string;
  /**
   * How many wallet-owned inputs come before the commit input, at indexes
   * 0..walletInputCount-1, all at `ordinalsAddress`: the parents, then any
   * satpoint inputs (ord's `satpoints` batch mode). Default 1.
   */
  walletInputCount?: number;
  /**
   * The ordinals address's public key (hex). Address-filter signers
   * (Unisat/Wizz/OKX) need it to compute their wallet-side (mainnet)
   * ordinals address for the `toSignInputs` filter — the parent input
   * is a Taproot key-path at the ordinals address, keyed differently
   * from the payment address. Index-based signers ignore it.
   */
  ordinalsPublicKey: string;
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
 *   - `signPaddedSatCommit`: inputs 0 and 1 = paymentAddress; or, with an
 *     `ordinalsAddress`, inputs 0 and 2 = paymentAddress and 1 = ordinalsAddress.
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
  signChildRevealParentInputs(input: SignChildRevealParentInputsArgs): Observable<{ txId: string }>;
  signPaddedSatCommit(input: SignPaddedSatCommitArgs): Observable<{ txId: string }>;
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
}



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
