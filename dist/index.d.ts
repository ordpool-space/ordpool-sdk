import { Observable, Subject, BehaviorSubject } from 'rxjs';
import { AddressPurpose } from 'sats-connect';
import * as btc from '@scure/btc-signer';
import * as _angular_core from '@angular/core';
import { InjectionToken } from '@angular/core';
import * as ordpool_sdk from 'ordpool-sdk';
import { HttpClient } from '@angular/common/http';

/**
 * Canonical CAT-21 postage. Every cat-bearing UTXO across the protocol is
 * exactly this value — 546 sats — and every cat-touching tx puts the cat
 * at output 0 with this exact amount.
 *
 * The number is the conservative cross-address-type dust floor (P2TR 330,
 * P2WPKH 294, P2SH 540 — 546 clears them all). Pinning one value across
 * mint, transfer, and offer flows means a cat UTXO is fungible across
 * address types: a cat in P2TR can be moved into P2SH-P2WPKH without
 * re-dust-validating.
 *
 * **No `postageSats` override on any builder.** A future address type with
 * higher dust requirements is a protocol event, not a builder argument.
 * The rule is enforced at exactly one place per builder via this constant
 * plus a runtime assert on cat-input value.
 *
 * See SDK CLAUDE.md "cat UTXO is always 546 sats, FIFO (input 0 → output 0)".
 */
declare const CAT21_POSTAGE_SATS = 546;

/**
 * The CAT-21 protocol marker. Every cat-touching tx OUR code builds
 * carries `nLockTime = 21`. cat21-ord reads the field structurally
 * (no consensus enforcement — block 21 was mined in 2009, so the
 * constraint is trivially satisfied) and mints a fresh cat at the
 * first sat of the first output.
 *
 * Used by the mint builder (creates a cat from nothing), the
 * transfer builder (carries the existing cat AND mints a fresh one
 * on the same ordinal — the cherry on top), and the buy-offer
 * builder (offer-acceptance tx is also a mint by the same rule).
 *
 * The number `21` is data, not a time-lock. See SDK CLAUDE.md
 * HARD RULE "CAT-21 mints — RBF policy (per-wallet)" for the full
 * story plus the per-wallet sequence interaction.
 */
declare const CAT21_LOCK_TIME = 21;
/**
 * Hard runtime assertion. Every Layer-1 builder calls this after
 * constructing its scure `Transaction` and before returning bytes.
 * A diverging lockTime means the constructor was passed something
 * other than `CAT21_LOCK_TIME`, which is a load-bearing-bug-class
 * mistake (cat21-ord wouldn't mint the cat).
 */
declare function assertCat21LockTime(lockTime: number): void;

/**
 * Sats-connect's `BitcoinNetworkType` enum, redeclared locally.
 *
 * Why not import from `sats-connect` directly: sats-connect's index
 * pulls axios (and therefore `process/browser`) into anything that
 * imports `ordpool-sdk/core`. The wallet's MV3 background bundle
 * can't resolve `process/browser` from inside the SDK's
 * `node_modules/axios/lib`, so the whole core entry stops importing.
 * The enum values are wire-protocol strings, identical to what
 * sats-connect declares (`'Mainnet' | 'Testnet' | 'Testnet4' |
 * 'Signet' | 'Regtest'`), so a local copy passes Xverse's mode-
 * string check at runtime without any sats-connect code being
 * loaded.
 */
declare const BitcoinNetworkType: {
    readonly Mainnet: "Mainnet";
    readonly Testnet: "Testnet";
    readonly Testnet4: "Testnet4";
    readonly Signet: "Signet";
    readonly Regtest: "Regtest";
};
type BitcoinNetworkType = (typeof BitcoinNetworkType)[keyof typeof BitcoinNetworkType];
/**
 * Bitcoin network the SDK is operating on. Matches the bitcoinjs /
 * noble convention: explicit enum, not a boolean, `isMainnet` flattens
 * four distinct testnets into one, which has bitten us before.
 *
 * Today only `Mainnet` is exercised in production (ordpool no longer
 * routes a testnet UI). The other variants exist so a future Node
 * script or CLI can target them without re-shaping the API.
 */
declare enum Network {
    Mainnet = "mainnet",
    Testnet3 = "testnet3",
    Testnet4 = "testnet4",
    Signet = "signet",
    Regtest = "regtest"
}
/**
 * Convert to @scure/btc-signer's network object. Mainnet -> NETWORK,
 * Regtest -> a hand-rolled `bcrt`-prefixed network object, all
 * remaining testnet variants -> TEST_NETWORK (scure doesn't
 * distinguish testnet3 / testnet4 / signet at this layer).
 */
declare function toScureNetwork(network: Network): typeof btc.NETWORK;
/**
 * Convert to sats-connect's BitcoinNetworkType. v4+ declares all
 * five variants natively (Mainnet, Testnet, Testnet4, Signet,
 * Regtest), so the v1-era `as BitcoinNetworkType` casts can go.
 *
 * Xverse's mismatch-check is string-equality between the request
 * `network.type` and the wallet's active chain `mode`; v4's enum
 * values match Xverse's mode strings exactly (one of the reasons
 * upgrading was worth doing).
 */
declare function toBitcoinNetworkType(network: Network): BitcoinNetworkType;
/**
 * Leather wallet's `network` field accepts these strings.
 * Testnet variants flatten to 'testnet'.
 *
 * Regtest mapping nuance: upstream Leather labels its bcrt-HRP
 * network slot `devnet` (a Stacks-isms artifact inherited from
 * Hiro's stacks-devnet convention). CAT-21 wallet adds the
 * Bitcoin-standard `regtest` slot alongside it (see the wallet's
 * `WalletDefaultNetworkConfigurationIds.regtest` HACK marker), so
 * we return the standard term going forward. The wallet still
 * accepts `'devnet'` for back-compat with dapps written against
 * the upstream-Leather contract.
 */
declare function toLeatherNetworkString(network: Network): 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet' | 'regtest';

/**
 * Minimal shape of `window` for wallet detection. Real browser
 * extensions inject these properties; in tests we pass a stub
 * object with whatever subset we want present.
 */
interface WindowLike {
    XverseProviders?: unknown;
    LeatherProvider?: unknown;
    HiroWalletProvider?: unknown;
    unisat?: unknown;
    wizz?: unknown;
    atom?: unknown;
    okxwallet?: unknown;
    phantom?: unknown;
    oyl?: unknown;
    alby?: unknown;
    webln?: unknown;
    binancew3w?: unknown;
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
interface WalletConnector {
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
declare enum KnownOrdinalWalletType {
    xverse = "xverse",
    leather = "leather",
    unisat = "unisat",
    wizz = "wizz",
    okx = "okx",
    phantom = "phantom",
    oyl = "oyl",
    alby = "alby",
    binance = "binance",
    /**
     * CAT-21 wallet — our own Bitcoin-L1 wallet, forked from Leather.
     * The maintainer ships this one. Provider lives at
     * `window.Cat21Provider` (with `isCat21: true`) per
     * INTEGRATION-ORDPOOL-SDK.md in the cat21-wallet repo. Wire
     * protocol matches Leather's Bitcoin RPC subset
     * (getAddresses / signPsbt / etc.) so the connector + signer
     * shape mirrors Leather's. Stacks methods are stripped.
     */
    cat21wallet = "cat21wallet",
    /**
     * Watch-only via BIP-32 xpub paste. Covers Sparrow, Electrum,
     * Coldcard, Ledger, Trezor, Specter, Bitcoin Core — every desktop
     * or hardware wallet that doesn't inject into the browser but
     * speaks PSBT and exports an xpub.
     */
    xpub = "xpub"
}
interface KnownOrdinalWallet {
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
declare const KnownOrdinalWallets: {
    [K in KnownOrdinalWalletType]: KnownOrdinalWallet;
};
interface WalletInfo {
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
interface XverseAddressResponse {
    addresses: {
        address: string;
        publicKey: string;
        purpose: AddressPurpose.Ordinals | AddressPurpose.Payment;
    }[];
}
interface LeatherAddressResponse {
    jsonrpc: string;
    id: string;
    result: {
        addresses: LeatherAddress[];
    };
}
type LeatherAddress = LeatherBtcAddress | LeatherStxAddress;
interface LeatherBtcAddress {
    symbol: 'BTC';
    type: string;
    address: string;
    publicKey: string;
    derivationPath: string;
    tweakedPublicKey?: string;
}
interface LeatherStxAddress {
    symbol: 'STX';
    address: string;
}

/**
 * RBF-signalling. Used by every CAT-21 tx Cat21 Wallet builds (mint,
 * transfer, and any future cat-flow). Our own accelerate code path is
 * required to preserve `lockTime=21` through any RBF replacement
 * (cat21-wallet HARD RULE #1), so signalling RBF is safe AND useful —
 * users can bump a stuck fee without rebuilding the transaction.
 */
declare const CAT21_WALLET_INPUT_SEQUENCE = 4294967293;
/**
 * Non-RBF. Used for every CAT-21 mint signed by a third-party wallet
 * (Xverse, Unisat, Leather, OKX, Oyl, Wizz, Phantom, Alby, …). Locks
 * their accelerate UI out of touching the marker — the 2024 Xverse
 * incident defence. (Note: only the MINT path applies this gate;
 * transfers and offers allow RBF for everyone, since cats are
 * immutable once on chain and the worst third-party-RBF outcome is a
 * missed bonus mint, not a cat loss.)
 */
declare const CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE = 4294967294;
/**
 * Single source of truth for the per-wallet input sequence on any
 * cat-touching tx OUR code builds. The mint, transfer, and any future
 * cat-flow builder MUST import this helper, NEVER re-implement the
 * ternary. The SDK CLAUDE.md "CAT-21 mints — RBF policy (per-wallet)"
 * rule is enforced at exactly ONE place: this function.
 *
 * The value `21` (lockTime) has no consensus meaning — block 21 was
 * mined in 2009, so the constraint is trivially satisfied no matter
 * when the tx lands. The field is repurposed as protocol-marker data
 * that cat21-ord reads structurally. The sequence choice gates which
 * wallets' fee-bump UI fires on the broadcast tx; that's the real
 * protection axis.
 */
declare function resolveCat21InputSequence(walletType: KnownOrdinalWalletType): number;

/**
 * Address-format detection and Bitcoin dust-floor helpers.
 *
 * Used across the CAT-21 pipeline (mint, transfer, offer) AND by
 * cat21.space's per-address-type dust math in `createTransaction`.
 * Lives in `cat21-script/` because every consumer that constructs
 * scure scripts also needs to detect the address shape it's working
 * with.
 *
 * No CAT-21-specific semantics — pure Bitcoin address-format logic.
 */
/**
 * Conservative dust-floor (in sats) per address type. P2SH could
 * be Nested SegWit (540) or full-witness-script wrap; we return 546
 * uniformly — the 6-sat slack is negligible. P2PK is not supported.
 *
 *   P2PKH               → 546
 *   P2SH (any wrap)     → 546
 *   P2WPKH              → 294
 *   P2TR                → 330
 *
 * References:
 *   https://help.magiceden.io/en/articles/8665399-navigating-bitcoin-dust-understanding-limits-and-safeguarding-your-transactions-on-magic-eden
 *   https://en.bitcoin.it/wiki/List_of_address_prefixes
 *   https://unchained.com/blog/bitcoin-address-types-compared/
 *
 * @throws if the address prefix isn't recognised.
 */
declare function getMinimumUtxoSize(address: string): number;
/**
 * Address format from prefix. `P2SH???` because P2SH covers multiple
 * wrap shapes (P2SH-P2WPKH, P2SH-P2WSH); resolving the inner shape
 * needs the redeem script. P2PK not supported.
 *
 *   '1' / 'm' / 'n'                   → P2PKH
 *   '3' / '2'                         → P2SH???
 *   'bc1q' / 'tb1q' / 'bcrt1q'        → P2WPKH
 *   'bc1p' / 'tb1p' / 'bcrt1p'        → P2TR
 *
 * @throws if the prefix isn't recognised.
 */
declare function getAddressFormat(address: string): 'P2WPKH' | 'P2SH???' | 'P2TR' | 'P2PKH';
/**
 * Determines whether a given Bitcoin address is a Segregated Witness (SegWit) address.
 *
 * The determination of P2SH addresses as SegWit is based on the assumption that P2SH addresses
 * are being used for SegWit purposes, which may not always be the case.
 */
declare function isSegWit(address: string): boolean;
/**
 * Coarse network grouping reachable from an address prefix.
 *
 *   'mainnet'  — clearly mainnet (`1` / `3` / `bc1` / `bc1p`).
 *   'regtest'  — clearly regtest (`bcrt1` / `bcrt1p`).
 *   'testnet'  — testnet-or-signet bech32 (`tb1` / `tb1p`), OR any of
 *                the legacy testnet/regtest/signet bytes (`m` / `n` /
 *                `2`). Legacy regtest shares the same key bytes as
 *                testnet, so the address alone can't disambiguate.
 *
 * Consumers use this to verify the wallet's connected network
 * matches what the dapp expects — same address prefix is the
 * cheapest fact available, no extra wallet calls, no popup.
 */
type AddressNetworkGroup = 'mainnet' | 'regtest' | 'testnet';
declare function getAddressNetwork(address: string): AddressNetworkGroup;
/**
 * `true` when the address could plausibly belong to the network. The
 * legacy testnet / regtest / signet share key bytes so an `m...`
 * address compares true against any non-mainnet network. Use this
 * for the consumer's "wrong-network" red warning — false means
 * "definitely don't sign here".
 *
 * Network values map to address groups as follows:
 *   - `Network.Mainnet`  → 'mainnet'
 *   - `Network.Regtest`  → 'regtest' (also accepts 'testnet' for the
 *                          legacy-byte ambiguity)
 *   - `Network.Testnet3 / Testnet4 / Signet` → 'testnet' (also
 *                          accepts 'regtest' for the same reason)
 */
declare function isAddressCompatibleWithNetwork(address: string, expectedNetworkGroup: AddressNetworkGroup): boolean;
/**
 * Converts a full public key (including the y-coordinate parity byte) into an x-only public key.
 *
 * In the context of Schnorr signatures and Taproot transactions in Bitcoin, public keys are represented
 * as x-only coordinates. This is because Schnorr signatures utilize x-only public keys, which are 32 bytes long
 * and consist only of the x-coordinate of the elliptic curve point.
 *
 * The first byte of a compressed ECDSA public key (0x02 or 0x03) indicates the y-coordinate's parity
 * and is unnecessary for Schnorr signatures. Removing this byte aligns the public key format with the
 * Schnorr and Taproot standards.
 *
 * as seen here: https://github.com/paulmillr/scure-btc-signer/discussions/77
 *
 * @param pubkey - The full public key, including the y-coordinate parity byte at the beginning.
 * @returns The x-only public key, with the y-coordinate parity byte removed.
 */
declare function toXOnly(pubkey: Uint8Array): Uint8Array;

/**
 * Universal input-script builder. Dispatches purely on the
 * `paymentAddress` format — no wallet-name switch. Any wallet
 * produces a correct input shape as long as it returns a payment
 * address + pubkey. Taproot x-only normalisation happens at runtime
 * from the pubkey's length (32 vs 33 bytes).
 *
 * Pure. Used by every CAT-21 Layer-2 adapter (mint, transfer, offer).
 */
interface BuildInputScriptArgs {
    paymentAddress: string;
    /**
     * Payment public key from the wallet's `getAddresses`-equivalent
     * call. ALL wallets agree on:
     *   - 33-byte compressed for non-taproot inputs
     *   - 32-byte x-only OR 33-byte compressed for taproot (the SDK
     *     normalises by stripping the parity byte when 33 bytes are
     *     supplied; the wallet handed us either form depending on its
     *     convention).
     */
    paymentPublicKey: Uint8Array;
    /**
     * Simulation mode: swap the supplied pubkey for the SDK's
     * well-known dummy keypair so vsize is observable during the
     * two-pass fee simulation without exposing the user's key.
     * NEVER use the result of a simulation build for real signing.
     */
    isSimulation: boolean;
    network: typeof btc.NETWORK;
}
interface BuildInputScriptResult {
    /**
     * Scure script object — `P2Ret` for everything except Taproot,
     * `P2TROut` for Taproot. Both expose `script` (the scriptPubKey)
     * and Taproot additionally exposes the script-path tweaks the
     * adapter merges into the input.
     */
    scriptData: btc.P2Ret | btc.P2TROut;
    /**
     * Only set for Taproot — the x-only internal key the adapter
     * attaches to the input so a key-path signer produces a valid
     * Schnorr signature. `undefined` for every other address format.
     */
    tapInternalKey: Uint8Array | undefined;
}
/**
 * Build the scure script for a payment input.
 *
 * The decision is:
 *   - Look at `paymentAddress` → derive the script type.
 *   - For Taproot: ensure the pubkey is x-only (32 bytes) — strip
 *     the parity byte if a 33-byte compressed key was supplied.
 *   - If `isSimulation`, swap in the dummy keypair before any of
 *     the above (Taproot simulation uses the schnorr-derived x-only
 *     dummy; non-taproot uses the compressed dummy).
 *
 * That's the whole algorithm. No per-wallet branching, anywhere.
 */
declare function buildInputScript(args: BuildInputScriptArgs): BuildInputScriptResult;

/**
 * Minimal contract for browser-side key/value persistence the SDK
 * needs (cat21 mint history, last-connected-wallet snapshot). Matches
 * the surface ordpool/frontend's `StorageService` already exposes, so
 * the frontend can satisfy this token with `{ provide: storage,
 * useExisting: StorageService }`.
 *
 * Pure-Node consumers can pass an in-memory shim if they ever need to;
 * the SDK doesn't care what's behind the interface.
 */
interface StorageLike {
    getValue(key: string): string | null;
    setValue(key: string, value: string): void;
    removeItem(key: string): void;
}
declare const storage: InjectionToken<StorageLike>;

/**
 * Consumers provide this in their root injector — `useValue: Network.Mainnet`
 * is the only realistic answer in the ordpool frontend today.
 *
 * Lives in its own file so `network.ts` (enum + converters) stays
 * Angular-free and tree-shakes / runs in Node without dragging in
 * `@angular/core`.
 */
declare const bitcoinNetwork: InjectionToken<Network>;

declare const leatherOrdinalsAddressType = "p2tr";
declare const leatherPaymentAddressType = "p2wpkh";

declare const LAST_CONNECTED_WALLET = "LAST_CONNECTED_WALLET";
declare class WalletService {
    storageService: ordpool_sdk.StorageLike;
    network: Network;
    walletConnectRequested$: Subject<boolean>;
    connectedWallet$: BehaviorSubject<WalletInfo>;
    wallets$: Observable<{
        installedWallets: KnownOrdinalWallet[];
        notInstalledWallets: KnownOrdinalWallet[];
    }>;
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
    private accountChangeUnsubscribe;
    constructor();
    private get win();
    private findConnector;
    getInstalledWallets(): {
        installedWallets: KnownOrdinalWallet[];
        notInstalledWallets: KnownOrdinalWallet[];
    };
    connectWallet(key: KnownOrdinalWalletType): Observable<WalletInfo>;
    connectFakeWallet(walletInfo: WalletInfo): void;
    disconnectWallet(): void;
    /**
     * Subscribe to the connector's `onAccountChange` (if exposed). When
     * the wallet emits an account / network / disconnect event we
     * re-call `connect()` silently — most wallets return the current
     * account without a popup once the user has previously approved.
     * The fresh WalletInfo overwrites the cached one, so the UI
     * updates automatically through `connectedWallet$`. On failure we
     * disconnect (the wallet has lost the connection).
     */
    private armAccountChangeSubscription;
    private tearDownAccountChangeSubscription;
    requestWalletConnect(): void;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<WalletService, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<WalletService>;
}

/**
 * Runtime config the cat21-mint services need. Provided by the
 * consumer's DI; the SDK doesn't know about specific environments.
 *
 * - `mempoolApiUrl` — base URL of the Esplora-compatible backend
 *   (utxo lookups, raw-tx fetch, broadcast). The network the URL
 *   points at must match `bitcoinNetwork`; the consumer picks both.
 * - `cat21ApiUrl` — base URL of the cat21-indexer REST API
 *   (status, cats list). Same rule — match the URL to
 *   `bitcoinNetwork`.
 * - `ordApiUrl` — base URL of an ord JSON API (typically our ord
 *   instance at `ord.ordpool.space`). Used by `UtxoContentScanner`
 *   to detect inscriptions + runes per outpoint before the user
 *   mints with that UTXO.
 * - `cat21OrdApiUrl` — base URL of cat21-ord (typically
 *   `ord.cat21.space`). Same scanner uses it to detect CAT-21 cats
 *   per outpoint.
 */
interface Cat21SdkConfig {
    mempoolApiUrl: string;
    cat21ApiUrl: string;
    ordApiUrl: string;
    cat21OrdApiUrl: string;
}
declare const cat21Config: InjectionToken<Cat21SdkConfig>;

/**
 * Esplora-API `status` shape on a UTXO record. Mirrors the field set
 * mempool/electrs returns; inlined here so the SDK doesn't reach back
 * into the frontend's `interfaces/electrs.interface.ts`.
 */
interface TxnOutputStatus {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
}
interface TxnOutput {
    txid: string;
    vout: number;
    status: TxnOutputStatus;
    value: number;
    transactionHex?: string;
}
interface LeatherSignPsbtRequestParams {
    hex: string;
    allowedSighash?: any[];
    signAtIndex?: number | number[];
    network?: 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet';
    account?: number;
    broadcast?: boolean;
}
interface LeatherPSBTBroadcastResponse {
    jsonrpc: string;
    id: string;
    result: {
        hex: string;
    };
}
interface DummyKeypairResult {
    dummyPrivateKey: Uint8Array;
    dummyPublicKey: Uint8Array;
    xOnlyDummyPublicKey: Uint8Array;
    /**
     * "Legacy" Pay-to-Public-Key-Hash (P2PKH)
     */
    addressP2PKH: string;
    /**
     * Nested Segwit (P2SH-P2WPKH)
     */
    addressP2SH_P2WPKH: string;
    /**
     * Native Seqwit (P2WPKH)
     */
    addressP2WPKH: string;
    /**
     * TapRoot (P2TR)
     */
    addressP2TR: string;
}
interface CreateTransactionResult {
    tx: btc.Transaction;
    amountToRecipient: bigint;
    singleInputAmount: bigint;
    changeAmount: bigint;
    finalTransactionFee: bigint;
}
interface SimulateTransactionResult extends CreateTransactionResult {
    vsize: number;
}
/**
 * Trimmed shape of a mempool transaction as returned by electrs
 * (`/api/address/:addr/txs/mempool`). Only the fields the pendingMints
 * helper needs are declared — electrs returns more (vin, scriptpubkey
 * details, weight breakdowns), all ignored.
 */
interface MempoolTx {
    txid: string;
    locktime: number;
    weight: number;
    fee: number;
    vout: Array<{
        scriptpubkey_address?: string;
        value: number;
    }>;
}
/**
 * A CAT-21 mint we've spotted in the mempool addressed to one of the
 * wallet's queried addresses. `seenAt` is the ISO timestamp of the
 * first poll that included this txid — stable across re-emissions in
 * the same polling session, so a UI can render "in mempool for 2m".
 */
interface PendingMint {
    txid: string;
    vsize: number;
    fee: number;
    feeRate: number;
    recipientAddress: string;
    seenAt: string;
}
/**
 * Shape of the mempool-framework `/api/v1/fees/recommended` response
 * (api.ordpool.space proxies/serves it). Five tiers in sat/vB —
 * fastest within ~10 minutes, halfHour, hour, economy, and the
 * mempool minimum that would be accepted at all. The fee picker in
 * both consumers renders the three middle tiers as quick-pick
 * buttons; minimumFee is used as a lower-bound validation hint.
 */
interface RecommendedFees {
    fastestFee: number;
    halfHourFee: number;
    hourFee: number;
    economyFee: number;
    minimumFee: number;
}

declare class Cat21Service {
    private config;
    private network;
    mempoolApiUrl: string;
    http: HttpClient;
    private txHexCache;
    /**
     * Get the list of unspent transaction outputs associated with the address/scripthash.
     * Available fields: txid, vout, value, and status (with the status of the funding tx).
     *
     * If the address is non-segwit, then we als fetch the transaction hex to be able
     * to construct the input later on
     *
     * @param address The Bitcoin address to query.
     * @returns An Observable of UTXO array.
     * @see https://github.com/Blockstream/esplora/blob/master/API.md#get-addressaddressutxo
     */
    getUtxos(address: string): Observable<TxnOutput[]>;
    /**
     * Returns a transaction serialized as hex (cached).
     * @param transactionId The Bitcoin transaction ID.
     * @returns An Observable of the transaction serialized as a hex string.
     * @see https://github.com/Blockstream/esplora/blob/master/API.md#get-txtxidhex
     */
    getTransactionHex(transactionId: string): Observable<string>;
    /**
     * POST /tx
     * Broadcast a raw transaction to the network.
     * @param hexPayload The transaction should be provided as hex in the request body.
     * @returns The txid will be returned on success.
     * @see https://github.com/Blockstream/esplora/blob/master/API.md#post-tx
     */
    postTransaction(hexPayload: string): Observable<string>;
    /**
     * Constructs a fake CAT-21 mint transaction,
     * finalizes the txn and receives the vsize
     *
     * Throws an Error if paymentOutput has not enough funds!
     * - 'Insufficient funds for transaction' via the createTransaction
     * - 'Outputs spends more than inputs amount' when we finalize (second safety net)
     */
    simulateTransaction(walletType: KnownOrdinalWalletType, recipientAddress: string, paymentOutput: TxnOutput, paymentAddress: string, paymentPublicKey: Uint8Array, transactionFee: bigint): SimulateTransactionResult;
    /**
     * Parse a PSBT, dummy-sign input 0 with the well-known dummy key,
     * finalise, and return the scure Transaction. Used by the Layer-3
     * `twoPassFeeSimulation` helper as its `signSimulation` callback.
     *
     * The dummy key is the SDK's well-known fixed key (`getDummyKeypair`);
     * the signature is structurally valid (correct DER length, correct
     * sighash byte) so `tx.vsize` matches what a real-signed tx would
     * have. Only used in simulation paths; never broadcast.
     */
    dummySignAndFinalize(psbtBytes: Uint8Array): btc.Transaction;
    /**
     * Constructs a PSBT with a CAT-21 mint transaction,
     * prompts the user to sign it and broadcasts the transaction.
     *
     * Emits the broadcast `txId` and nothing else — the consumer already
     * has every other field it passed in (wallet, addresses) and the
     * network is known from the injected `bitcoinNetwork` token. Pending
     * mempool tracking after broadcast is the consumer's job (see
     * `pendingMints$`).
     */
    createCat21Transaction(walletType: KnownOrdinalWalletType, recipientAddress: string, paymentOutput: TxnOutput, paymentAddress: string, paymentPublicKey: Uint8Array, transactionFee: bigint): Observable<{
        txId: string;
    }>;
    /**
     * Stream of CAT-21 mints currently in the mempool whose first output
     * is addressed to one of the supplied addresses.
     *
     * Polls electrs every 30s for as long as anyone is subscribed. The
     * SDK does NOT auto-stop on wallet disconnect — the consumer
     * unsubscribes (e.g. by switching to a fresh observable when the
     * wallet changes, or destroying the component) to stop polling.
     *
     * Cross-device awareness: because the source of truth is the
     * mempool (not localStorage), a mint started from another device is
     * picked up by the next poll cycle.
     *
     * Empty `addresses` returns `of([])` immediately — no polling, no
     * subscription overhead. Useful when a component renders before a
     * wallet is connected.
     *
     * Each call to this method returns a fresh observable with its own
     * polling chain. Multiple subscribers of the SAME returned
     * observable share the chain via `shareReplay({refCount:true})`.
     */
    /**
     * Stream of mempool-framework recommended fee rates, polled every
     * 30s. Built lazily on first subscribe via `shareReplay({refCount:
     * true})` so multiple subscribers share one polling chain.
     *
     * The endpoint (`/api/v1/fees/recommended`) is served by the same
     * `mempoolApiUrl` as the rest of the mint flow — on prod for
     * cat21.space that's `api.ordpool.space` (we run it ourselves);
     * for ordpool's own frontend it's whatever ordpool's environment
     * points at. No third-party dependency.
     */
    readonly recommendedFees$: Observable<RecommendedFees>;
    pendingMints$(addresses: string[]): Observable<PendingMint[]>;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<Cat21Service, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<Cat21Service>;
}

/**
 * Deterministic dummy keypair for SIMULATION only. Private key is
 * the hardcoded constant `0x0101…01`; addresses for P2PKH,
 * P2SH-P2WPKH, P2WPKH, P2TR are pre-derived so every Layer-2 input
 * adapter can dummy-sign its matching shape. Cached per network
 * bech32 prefix.
 *
 * **Never broadcast** — the private key is publicly known, so
 * signatures provide zero security.
 *
 * For Taproot inputs use `xOnlyDummyPublicKey`; the ECDSA
 * `dummyPublicKey` will not work.
 */
declare function getDummyKeypair(network: typeof btc.NETWORK): DummyKeypairResult;
/**
 * Generates a dummy legacy (P2PKH) transaction for the
 * simulation pass. Used to construct a `nonWitnessUtxo` field on
 * legacy P2PKH funding inputs (scure requires the full previous-tx
 * bytes for legacy inputs, see paulmillr/scure-btc-signer README).
 *
 * The transaction includes a number of outputs equal to the `vout`
 * of the provided `TxnOutput`, each output carrying the same value.
 */
declare function getDummyLegacyTransaction(txnOutput: TxnOutput, network: typeof btc.NETWORK): btc.Transaction;

/**
 * Layer-4 orchestration entry: adapts cat21.space-shaped args to
 * `prepareMintInputForWallet` (Layer 2) + `buildCat21MintPsbt`
 * (Layer 1). One PSBT-assembly path for cat21.space and
 * cat21-wallet's autonomous flow.
 *
 * Change below the per-address-type dust limit is absorbed into
 * the miner fee; above it, a second output is added.
 */
declare function createTransaction(walletType: KnownOrdinalWalletType, recipientAddress: string, paymentOutput: TxnOutput, paymentPublicKey: Uint8Array, paymentAddress: string, transactionFee: bigint, isSimulation: boolean, network: Network): CreateTransactionResult;

interface StatusResult {
    totalCats: number;
    lastSyncedCatNumber: number;
    proofOfCatWork: number;
}
interface CatNumbersResult {
    catNumbers: number[];
    total: number;
    currentPage: number;
    itemsPerPage: number;
}
interface Cat21 {
    transactionId: string;
    blockId: string;
    number: number;
    feeRate: number;
    blockHeight: number;
    blockTime: number;
    fee: number;
    size: number;
    weight: number;
    value: number;
    sat: number;
    firstOwner: string;
}
interface Cat21PaginatedResult {
    cats: Cat21[];
    totalResults: number;
    itemsPerPage: number;
    currentPage: number;
}
interface Cat21SingleResult {
    cat: Cat21;
    previousTransactionId: string | null;
    nextTransactionId: string | null;
}
interface ErrorResponse {
    statusCode: number;
    timestamp: string;
    path: string;
    message: string;
    stack?: string;
}
declare class Cat21ApiService {
    private config;
    private baseUrl;
    private http;
    getStatus(): Observable<StatusResult>;
    getLatestCatNumbers(itemsPerPage: number): Observable<CatNumbersResult>;
    getCatImageUrl(catNumber: number): string;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<Cat21ApiService, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<Cat21ApiService>;
}

/**
 * One row in the orchestrator's `simulations$` stream. Either:
 * - `insufficient: true` — the UTXO can't cover the recipient amount
 *   (546 sats) + the fee at the current rate. `simulation` is null.
 * - `insufficient: false` — UTXO is viable; `simulation` carries the
 *   full breakdown (vsize, miner fee, change amount, etc.) the UI
 *   needs to render an "this is what'll happen" panel.
 */
interface UtxoSimulation {
    utxo: TxnOutput;
    simulation: SimulateTransactionResult | null;
    insufficient: boolean;
}
/**
 * State machine the consumer's template branches on. Single-source-of-
 * truth for "what should the UI show right now":
 *
 *  - `idle` — no wallet connected.
 *  - `loading-utxos` — wallet just connected, fetching UTXOs from electrs.
 *  - `ready` — UTXOs loaded; the form is interactive.
 *  - `minting` — user clicked "Mint", PSBT being signed / broadcast.
 *  - `success` — broadcast OK; `successTxId` holds the txid.
 *  - `error` — something failed; `errorMessage` holds the reason.
 */
type MintState = 'idle' | 'loading-utxos' | 'ready' | 'minting' | 'success' | 'error';
/**
 * High-level mint flow. Wraps `Cat21Service` (UTXOs, simulation,
 * broadcast) + `WalletService` (the currently connected wallet) into
 * one cohesive surface so both consumers (ordpool/frontend and
 * cat21-indexer/frontend) drive the same state machine and reactive
 * pipelines with thin templates.
 *
 * Singleton (`providedIn: 'root'`) — state persists across route
 * navigations within a session. Auto-resets `feeRate` + `selectedUtxo`
 * + the success/error fields when the connected wallet changes (the
 * old UTXO is gone; the user picks fresh for the new wallet).
 */
declare class Cat21MintOrchestrator {
    private wallet;
    private cat21;
    /** sat/vB the user picked (from the fee picker or manually). null until set. */
    readonly feeRate: _angular_core.WritableSignal<number>;
    /** Which UTXO from the list the user picked (auto-set to the largest viable one by default). */
    readonly selectedUtxo: _angular_core.WritableSignal<TxnOutput>;
    private lastWalletAddress;
    private readonly feeRateSubject;
    readonly state: _angular_core.WritableSignal<MintState>;
    readonly errorMessage: _angular_core.WritableSignal<string>;
    readonly successTxId: _angular_core.WritableSignal<string>;
    /** Currently connected wallet bridged to a signal for template reads. */
    readonly connectedWallet: _angular_core.Signal<WalletInfo>;
    /** Convenience computed for `state() === 'ready'` gating. */
    readonly isReady: _angular_core.Signal<boolean>;
    /**
     * UTXOs for the connected wallet's payment address. Re-fetches on
     * wallet change. Errors are mapped to an empty list and an error
     * state. Shared between subscribers via `shareReplay` so the side
     * effects on `state` only fire once per emission.
     *
     * `startWith(null)` keeps the chain hot before any wallet connects;
     * downstream `simulations$` then emits `[]` instead of stalling.
     */
    readonly utxos$: Observable<TxnOutput[]>;
    /**
     * For each UTXO + current fee rate, run the two-pass simulation
     * (pass 1 estimates vsize at fee=0; pass 2 uses the real fee
     * derived from vsize × feeRate). UTXOs that throw on simulation
     * (insufficient funds at this fee rate) come through with
     * `insufficient: true` rather than poisoning the whole stream.
     *
     * Re-emits whenever utxos$ or feeRate changes.
     */
    readonly simulations$: Observable<UtxoSimulation[]>;
    /** Pass-through of the SDK's polled fee tiers. */
    readonly recommendedFees$: Observable<RecommendedFees>;
    constructor();
    private readonly walletChangeSub;
    setFeeRate(rate: number): void;
    setSelectedUtxo(utxo: TxnOutput | null): void;
    /**
     * Trigger the mint. Requires a connected wallet, a feeRate set, and
     * a selectedUtxo. Computes the precise fee from the simulation,
     * dispatches `Cat21Service.createCat21Transaction`, transitions
     * state to `minting` → `success` (with `successTxId`) or `error`
     * (with `errorMessage`).
     */
    mint(): Observable<{
        txId: string;
    }>;
    /**
     * Wipe form state back to a fresh mint (typically the "Mint another"
     * button on the success screen). Keeps the wallet connected.
     */
    reset(): void;
    private computeSimulations;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<Cat21MintOrchestrator, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<Cat21MintOrchestrator>;
}

/**
 * Funding UTXO that pays postage + miner fee + optional tip. Coin
 * selection is the caller's job; the builder does not select.
 *
 * Per-address-shape fields (set what applies; `prepareMintInputForWallet`
 * does this automatically):
 *   - SegWit v0 (P2WPKH): `scriptPubKey` only.
 *   - P2SH-wrapped SegWit: `scriptPubKey` + `redeemScript`.
 *   - Taproot key-path: `scriptPubKey` + `tapInternalKey`.
 *   - Legacy P2PKH: `scriptPubKey` + `nonWitnessUtxo` (full
 *     previous-tx bytes; scure requires this for legacy inputs).
 */
interface Cat21MintFundingInput {
    txid: string;
    vout: number;
    value: number;
    /** scriptPubKey bytes. */
    scriptPubKey: Uint8Array;
    /** For taproot inputs, the x-only internal public key. */
    tapInternalKey?: Uint8Array;
    /** For P2SH-wrapped SegWit inputs (Xverse, Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /**
     * For legacy P2PKH inputs (Unisat-Legacy). Full previous transaction
     * bytes — scure refuses to sign legacy inputs from witnessUtxo alone.
     */
    nonWitnessUtxo?: Uint8Array;
}

/**
 * Layer-2 input adapter for the CAT-21 mint pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the full `Cat21MintFundingInput` shape that
 * `buildCat21MintPsbt` consumes.
 *
 * Address-format-driven via `buildInputScript`. The wallet identity
 * is irrelevant — only the payment address shape matters.
 *
 * Pure function. No I/O, no Angular.
 */
declare function prepareMintInputForWallet(paymentOutput: TxnOutput, paymentPublicKey: Uint8Array, paymentAddress: string, isSimulation: boolean, network: Network): Cat21MintFundingInput;

/**
 * Asset-detection types for the mint flow's UTXO scanner. We query
 * BOTH our ord instance (`ord.ordpool.space`, returns regular
 * inscriptions + runes) AND our cat21-ord (`ord.cat21.space`, returns
 * CAT-21 cats) per outpoint, merging the answers into one
 * `UtxoContent`.
 *
 * The detection is content-safety, not fee-math: an inscription at the
 * dust limit (546 sat) reads as "tiny UTXO" to the picker but carries
 * arbitrary off-chain value. On single-address wallets, spending such
 * a UTXO as a mint input sends the asset to the miner as fee.
 */
/**
 * Raw `/output/{outpoint}` shape returned by ord with the JSON API
 * enabled. The subset we read here; ord ships more fields (address,
 * sat_ranges, script_pubkey, etc.) that we ignore.
 */
interface OrdOutputResponse {
    inscriptions?: string[];
    runes?: {
        [runeName: string]: unknown;
    } | null;
}
/**
 * Same shape from cat21-ord. The fork swaps the `inscriptions` field
 * for `cats` because `--index-cat21` only indexes CAT-21 fake-
 * inscriptions and explicitly excludes everything else. Runes are
 * never indexed by cat21-ord, so the field is always `null` there.
 */
interface Cat21OrdOutputResponse {
    cats?: string[];
}
/**
 * Aggregated content found at a single UTXO. Populated only when at
 * least one of the asset arrays is non-empty — clean UTXOs use the
 * `scanned-clean` scan-state variant instead of a `UtxoContent` with
 * empty arrays.
 */
interface UtxoContent {
    /** "txid:vout" — the outpoint we queried. */
    outpoint: string;
    /** Inscription IDs at this outpoint, in ord's standard `{txid}i{index}` format. */
    inscriptionIds: string[];
    /**
     * Rune name → balance object, exactly as ord's `/output/` endpoint
     * returns it. `null` when the upstream didn't supply a runes field
     * (cat21-ord) or returned `{}` (no runes here).
     */
    runes: {
        [runeName: string]: unknown;
    } | null;
    /** CAT-21 cat IDs at this outpoint, also in `{txid}i{index}` format. */
    catIds: string[];
}
/**
 * Per-UTXO scan state — drives the bucket-and-badge UI in both
 * frontends.
 *
 * - `not-scanned` — default for UTXOs above the auto-scan threshold.
 *   The picker shows a "Scan anyway" affordance.
 * - `scanning` — request in flight. Picker disables the row until
 *   the result lands.
 * - `scanned-clean` — both ord endpoints returned empty asset arrays.
 *   Picker marks the row safe; this is the auto-pick candidate.
 * - `scanned-with-assets` — at least one asset present. Picker shows
 *   what was found + links + an "Use anyway" override.
 * - `scan-failed` — at least one endpoint errored. Picker treats the
 *   row as "unknown safety" — neither auto-pick candidate nor blocked.
 */
type UtxoScanState = {
    kind: 'not-scanned';
} | {
    kind: 'scanning';
} | {
    kind: 'scanned-clean';
} | {
    kind: 'scanned-with-assets';
    content: UtxoContent;
} | {
    kind: 'scan-failed';
    message: string;
};
/**
 * Helper for templates — true iff the state name describes a completed
 * scan (clean, with-assets, or failed). Lets the UI distinguish "we
 * haven't tried" from "we tried and got an answer".
 */
declare function isScanComplete(s: UtxoScanState): boolean;
/**
 * Picker-display bucket the mint-flow UI bands UTXOs on. Maps 1:1 from
 * UtxoScanState but as a flat name the template can `@switch` on. Both
 * consumers (ordpool /cat21-mint and cat21.space /dashboard/mint) bind
 * the same five values; the SDK owns the type so they can't drift.
 */
type UtxoScanBucket = 'clean' | 'unscanned' | 'assets' | 'scanning' | 'failed';
/**
 * Map a UtxoScanState to its display bucket. Drives badge labels,
 * row-button copy, and the auto-pick priority order.
 */
declare function bucketOf(state: UtxoScanState): UtxoScanBucket;
/**
 * Auto-pick the largest "safe-enough" row from a bucket-annotated list.
 * Priority: scanned-clean (verified safe) → unscanned (probably-safe big
 * UTXO) → scan-failed (unknown, better than nothing). NEVER auto-pick
 * scanned-with-assets — that row requires an explicit "Use anyway"
 * click from the user.
 *
 * Callers pass any row shape that carries a `bucket` field; this
 * preserves the row type so consumers can use whatever shape they
 * stored (UtxoSimulation, ViableUtxoRow, etc.).
 */
declare function findAutoPickCandidate<T extends {
    bucket: UtxoScanBucket;
}>(rows: T[]): T | null;
/**
 * Names of every rune balance present on a scanned UTXO. `null` runes
 * (cat21-ord) or empty object short-circuits to an empty array. Used
 * by the asset-found UI to render one link per rune.
 */
declare function runeNamesFromContent(content: UtxoContent): string[];
/**
 * UTXOs at or below this value on a single-address wallet are flagged
 * as potentially holding an ordinal-bound asset (inscription, rune,
 * rare sat, CAT-21 cat). 10k sat is the de-facto industry cut-off:
 * most ordinal-bearing UTXOs are 546 sat (the dust limit) or slightly
 * above; almost none exceed 10k. Content-safety heuristics, not fee
 * math.
 */
declare const SMALL_UTXO_WARNING_THRESHOLD_SAT = 10000;
/**
 * Funding floor in sats for the empty-state hint in the mint flow.
 * Derived from the user's currently-picked fee rate using a
 * conservative ~200 vB reference vsize (real CAT-21 mints are
 * ~150–170 vB depending on wallet type), rounded up to the next 100
 * sat so the displayed number reads cleanly. At 1 sat/vB that's
 * ~800 sat; at 5 sat/vB ~1600; at 100 sat/vB ~20,600.
 *
 * The SDK's actual viable-UTXO check is dynamic per-PSBT; this helper
 * just stops the user-facing hint from quoting launch-era numbers
 * (10k or 200k sat) when current mainnet fees are much lower.
 */
declare function calculateRecommendedFundingSats(feeRatePerVb: number): number;

/**
 * UTXOs at or below this value are auto-scanned by callers that respect
 * the default policy (the mint-flow components do). Above the threshold
 * a UTXO is overwhelmingly likely to be a plain payment, so we leave it
 * `not-scanned` and let the user click "Scan anyway" if they want
 * certainty. The 50k figure: most ordinal-bearing UTXOs are 546-10k
 * sat; rare-sat UTXOs are typically dust-postaged too. A 50k+ UTXO is
 * a deliberate-payment shape.
 */
declare const AUTO_SCAN_MAX_VALUE_SAT = 50000;
/**
 * Per-outpoint asset scanner backed by our ord instance
 * (`ord.ordpool.space`, for inscriptions + runes) and cat21-ord
 * (`ord.cat21.space`, for CAT-21 cats). Results are cached for the
 * singleton's lifetime — a UTXO's content is immutable until the UTXO
 * is spent, and a spent UTXO doesn't appear in the payment-address
 * list anymore, so the cache never goes stale.
 *
 * The scanner does NOT decide which UTXOs to scan; the caller picks
 * via `scan(outpoint)`. The orchestrator exposes the auto-scan
 * convenience separately.
 */
declare class UtxoContentScanner {
    private http;
    private config;
    /** outpoint → latest state. */
    private readonly states;
    private readonly statesSubject;
    /**
     * Live snapshot of every outpoint's scan state. Subscribers receive
     * the full map on every change so they can re-derive any per-row
     * bucket in one pass — no per-outpoint observable factory needed.
     */
    readonly states$: Observable<ReadonlyMap<string, UtxoScanState>>;
    /** In-flight per-outpoint subscriptions so concurrent `scan()` calls dedupe. */
    private readonly inFlight;
    /**
     * Read the current state for one outpoint without subscribing.
     * Default: `not-scanned` for never-touched outpoints.
     */
    getState(outpoint: string): UtxoScanState;
    /**
     * Scan one outpoint. If already scanned, returns the cached state
     * synchronously via `of(...)`. If scan is in flight, returns the
     * existing observable so the network request runs once. Otherwise
     * fires both ord JSON queries in parallel, merges, caches, emits.
     *
     * The scan never throws — every failure mode is encoded into the
     * returned `UtxoScanState`.
     */
    scan(outpoint: string): Observable<UtxoScanState>;
    /**
     * Convenience batch scanner. Scans every outpoint whose UTXO value
     * is at or below `AUTO_SCAN_MAX_VALUE_SAT`. Throttles HTTP fan-out
     * via `mergeMap` with `AUTO_SCAN_CONCURRENCY` so a wallet with 30
     * UTXOs doesn't try to open 60 simultaneous TCP connections (browser
     * per-host cap is 6, anything above queues anyway). Returns nothing
     * — the caller reads results off the `states$` stream.
     */
    autoScan(utxos: {
        txid: string;
        vout: number;
        value: number;
    }[]): void;
    /**
     * Wipe both caches. Call this when the connected wallet changes —
     * UTXO outpoints from the previous wallet are no longer relevant
     * and would otherwise accumulate forever on a long-lived session
     * (the singleton's `states` Map is unbounded).
     */
    reset(): void;
    private fetchOrd;
    private fetchCat21Ord;
    private setState;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<UtxoContentScanner, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<UtxoContentScanner>;
}

/**
 * Layer-3 two-pass fee simulation for mint / transfer / offer.
 * vsize depends on the bytes, bytes depend on the fee (change
 * presence + size depends on what's left), so we build twice:
 *
 *   Pass 1 — placeholder fee → measure vsize.
 *   Pass 2 — `ceil(vsize × feeRate)` → measure FINAL vsize (may
 *            differ if change crossed the dust limit between passes).
 *
 * `finalFeeSats = ceil(pass2Vsize × feeRate)`. Pure function.
 *
 * The caller's `simulate(feeSats)` callback does the per-flow
 * dummy-sign:
 *   - Mint: build via createTransaction(simulation=true), dummy-sign
 *     input 0, finalise, return vsize.
 *   - Transfer: build + dummy-sign every input + finalise.
 *   - Offer (buyer): build + dummy-sign buyer inputs (seller stays
 *     unsigned by contract) + finalise with seller input stub.
 */
interface TwoPassFeeSimulationArgs<TResult extends {
    vsize: number;
}> {
    /**
     * Build the tx with the given fee, dummy-sign whatever needs signing
     * for vsize to be observable, return the full simulation result
     * (must include `vsize`; the caller can attach anything else needed
     * downstream — `tx`, `singleInputAmount`, etc.).
     */
    simulate: (feeSats: number) => TResult;
    /** Target fee rate in sat/vB. */
    feeRatePerVbyte: number;
    /** Placeholder fee used for the vsize-measuring pass. */
    placeholderFeeSats?: number;
}
interface TwoPassFeeSimulationResult<TResult extends {
    vsize: number;
}> {
    /** Final fee in sats, `ceil(pass2Vsize × feeRatePerVbyte)`. */
    finalFeeSats: number;
    /** Virtual size of the FINAL transaction, observed in pass 2. */
    vsize: number;
    /**
     * Pass-2 simulation result. Saves the caller a third
     * `simulate` call when the displayed/returned value is the
     * final-fee simulation itself (cat21.space's per-UTXO grid + the
     * `mint()` flow both want this).
     */
    finalSimulation: TResult;
}
/**
 * Run the two-pass loop and return the final fee + vsize +
 * the pass-2 simulation result. The pass-2 simulation is the one
 * the caller should USE for display or broadcast metadata — it's
 * the simulation that matches the final fee.
 */
declare function twoPassFeeSimulation<TResult extends {
    vsize: number;
}>(args: TwoPassFeeSimulationArgs<TResult>): TwoPassFeeSimulationResult<TResult>;

/**
 * Coin selection for CAT-21 flows. cat21.space lets the user pick
 * (Cat21MintOrchestrator simulates against every UTXO); cat21-wallet's
 * autonomous flows pick via the SDK.
 *
 * Two strategies:
 *   - `pickLargestFundingUtxoThatCovers` — **default**, matches the
 *     historic policy (see `findAutoPickCandidate`).
 *   - `pickSmallestFundingUtxoThatCovers` — opt-in, for strategies
 *     that want to preserve the largest balance (high-volume bot
 *     spending many small mints).
 *
 * Both pure. Caller MUST exclude cat-bearing UTXOs from the input
 * list — that filter is not this helper's job.
 */
interface FundingUtxo {
    txid: string;
    vout: number;
    /** Value in sats. */
    value: number;
}
interface PickFundingUtxoArgs<T extends FundingUtxo> {
    utxos: ReadonlyArray<T>;
    /** Minimum value the picked UTXO must cover. */
    targetSpendSats: number;
}
/**
 * **DEFAULT strategy.** Returns the LARGEST-value UTXO that covers
 * `targetSpendSats`; `null` if none does. Picked as default because
 * largest-first:
 *
 *   - has highest mint-success probability at high fee rates (no
 *     "Insufficient funds" surprise at the dust boundary);
 *   - defragments the wallet instead of fragmenting it;
 *   - avoids sub-dust change absorption (smallest-covers can leave
 *     change just under dust, where the builders fold it into the
 *     miner fee — the user over-pays).
 */
declare function pickLargestFundingUtxoThatCovers<T extends FundingUtxo>(args: PickFundingUtxoArgs<T>): T | null;
/**
 * OPT-IN strategy. Returns the UTXO with the SMALLEST value that
 * covers `targetSpendSats`. `null` when no UTXO is large enough.
 *
 * Use ONLY when the consumer explicitly wants to preserve their
 * largest balance for later — e.g. a high-volume autonomous bot
 * spending many small mints in sequence where defragmenting the
 * wallet against each mint would slowly consume the big balance.
 *
 * For most flows (cat21.space user flow, one-shot mints, transfers,
 * offer creation) `pickLargestFundingUtxoThatCovers` is the right
 * call. Default to that unless you have a documented reason.
 */
declare function pickSmallestFundingUtxoThatCovers<T extends FundingUtxo>(args: PickFundingUtxoArgs<T>): T | null;
/**
 * Returns ALL UTXOs that can cover `targetSpendSats`, sorted
 * largest-first (matches the default pick strategy). Useful when the
 * caller wants to enumerate options (e.g. cat21.space's per-UTXO
 * fee-simulation grid where the user picks from the list).
 */
declare function listFundingUtxosThatCover<T extends FundingUtxo>(args: PickFundingUtxoArgs<T>): T[];

/**
 * Alias for {@link CAT21_POSTAGE_SATS} kept for legacy import paths. The
 * canonical constant lives in `cat21-postage.ts`; every cat-touching tx
 * uses the same value across mint, transfer, and offer flows.
 */
declare const CAT21_OFFER_POSTAGE_SATS = 546;
/**
 * Description of the cat-bearing UTXO the offer is bidding on. The buyer
 * must know the seller's UTXO precisely so they can reference it in the
 * offer PSBT without a round-trip to the seller before signing.
 */
interface Cat21OfferSellerInput {
    txid: string;
    vout: number;
    /** Sats locked in the cat-bearing UTXO. Usually 546, caller passes through. */
    value: number;
    /** scriptPubKey of the seller's UTXO, raw bytes. */
    scriptPubKey: Uint8Array;
}
/**
 * Buyer-funded input the offer PSBT borrows to cover price + fee + postage.
 * Caller pre-selects these via the SDK's coin-selection logic (or its own);
 * the offer builder does NOT coin-select.
 */
interface Cat21OfferBuyerInput {
    txid: string;
    vout: number;
    value: number;
    scriptPubKey: Uint8Array;
    /**
     * For taproot inputs, the x-only internal public key. When set, the input
     * gets `tapInternalKey` populated so a taproot signer can produce a valid
     * key-path signature.
     */
    tapInternalKey?: Uint8Array;
    /** For P2SH-wrapped SegWit (Xverse / Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /**
     * For legacy P2PKH inputs (Unisat-Legacy). Full previous-tx bytes —
     * scure refuses to sign legacy inputs from witnessUtxo alone.
     */
    nonWitnessUtxo?: Uint8Array;
}
/** Output destinations of an ord-style offer. */
interface Cat21OfferDestinations {
    /** Where the cat lands. The first sat of this output ends up holding the cat. */
    buyerReceiveAddress: string;
    /** Where the buyer's BTC payment goes. */
    sellerPaymentAddress: string;
    /** Where buyer change goes (when above dust). */
    buyerChangeAddress: string;
}
/** Reasons a seller-side validator may reject an inbound offer PSBT. */
type Cat21OfferRejectionReason = 'missing-seller-input' | 'wrong-postage' | 'wrong-price' | 'wrong-seller-input-value' | 'sighash-not-all' | 'sighash-flag-byte-not-all' | 'buyer-input-unsigned' | 'missing-seller-payment-output' | 'payment-output-wrong-address' | 'cat-output-not-spendable';
interface Cat21OfferValidationResult {
    ok: true;
    pricePaidSats: number;
    postageSats: number;
}
interface Cat21OfferValidationFailure {
    ok: false;
    reason: Cat21OfferRejectionReason;
    detail?: string;
}
type Cat21OfferValidation = Cat21OfferValidationResult | Cat21OfferValidationFailure;

/**
 * Sequence number set on every input of a CAT-21 buy-offer PSBT.
 *
 * `0xfffffffd` signals BIP-125 RBF — the buyer (or any party with the
 * authority to rebuild the tx) can submit a higher-fee replacement if
 * the mempool congests after broadcast. This is the SDK default for
 * non-mint cat-flows per the cat21-wallet HARD RULE #1: offers and
 * transfers allow RBF; the only flow that disables RBF is the mint
 * (and only for third-party wallets that can't be trusted to preserve
 * `lockTime=21` through a replacement — see
 * `cat21-mint/cat21.service.helper.ts:CAT21_MINT_INPUT_SEQUENCE`).
 *
 * `@scure/btc-signer`'s default sequence is `0xffffffff` (final, RBF
 * off), so this MUST be set explicitly. Verified by reading the
 * scure source (`DEFAULT_SEQUENCE = 4294967295`).
 */
/**
 * @deprecated Use `resolveCat21InputSequence(walletType)` per the
 * per-wallet RBF policy unified across mint / transfer / offer flows
 * (audit M4). Left exported for spec backwards-compat; new callers
 * should not consume this constant directly.
 */
declare const CAT21_OFFER_INPUT_SEQUENCE = 4294967293;
/**
 * Arguments for `buildCat21BuyOfferPsbt`.
 *
 * The caller is responsible for coin selection (the SDK exposes coin-selection
 * helpers in `cat21-mint`; reuse them). This function only structures the PSBT
 * and validates the SIGHASH invariant; it does not pick UTXOs, fetch them, or
 * compute fees.
 */
interface BuildCat21BuyOfferArgs {
    /**
     * The BUYER's wallet type. Determines the input sequence number per
     * the unified per-wallet RBF policy (`resolveCat21InputSequence`):
     *   - `cat21wallet`: sequence = 0xfffffffd (RBF on; our accelerate
     *     flow preserves lockTime=21 through replacement, so signalling
     *     RBF is safe AND useful).
     *   - any other wallet: sequence = 0xfffffffe (RBF off; third-party
     *     accelerate UIs can't fire on this tx and accidentally drop the
     *     lockTime=21 marker, which would cost the buyer the cherry-on-
     *     top bonus mint cat).
     * Matches the mint/transfer flows.
     */
    walletType: KnownOrdinalWalletType;
    network: Network;
    sellerInput: Cat21OfferSellerInput;
    buyerInputs: Cat21OfferBuyerInput[];
    destinations: Cat21OfferDestinations;
    /**
     * Sats paid to the seller (net). The seller's payment output value is
     * `priceSats + CAT21_POSTAGE_SATS` so the seller is made whole on the
     * 546 sats they contribute via input 0 (ord-parity, see SDK CLAUDE.md
     * HARD RULE "cat UTXO is always 546 sats").
     */
    priceSats: number;
    /**
     * Miner fee in sats. Caller computes this from the chosen feeRate and the
     * estimated tx size (use `getBitcoinTransactionFee` from `cat21-mint` or any
     * equivalent). The builder does not compute fees because the buyer-funded
     * UTXOs may live in two different script types and only the caller knows
     * the correct size estimator.
     */
    feeSats: number;
}
interface BuildCat21BuyOfferResult {
    /** Raw hex of the unsigned tx (input 0 carries no buyer signature). */
    hex: string;
    /** Raw PSBT bytes. */
    psbt: Uint8Array;
    /** Total buyer-funded input value (sum of buyerInputs.value). */
    buyerInputTotalSats: number;
    /** Change output value (may be 0 when sub-dust; absorbed into fee). */
    changeSats: number;
}
/**
 * Builds the buyer-initiated CAT-21 offer PSBT (ord-style,
 * SIGHASH_ALL on every input).
 *
 * Structure:
 *   Input 0  — seller's cat UTXO. Witness data is pre-populated
 *              (scriptPubKey + value) so the seller can sign
 *              without a round-trip. UNSIGNED on emit.
 *   Input 1+ — buyer's funding UTXOs. All SIGHASH_ALL.
 *   Output 0 — buyer's receive address, postage sats. Cat lands here.
 *   Output 1 — seller's payment address, `priceSats`.
 *   Output 2 — buyer's change (absorbed into fee when sub-dust).
 *
 * Sniping-proof: when the PSBT leaves the buyer it's missing only
 * the seller's signature. Once the seller signs (SIGHASH_ALL),
 * every byte is committed by some signature — no half-signed PSBT
 * can be spliced into a sniping tx.
 */
declare function buildCat21BuyOfferPsbt(args: BuildCat21BuyOfferArgs): BuildCat21BuyOfferResult;
/**
 * Arguments for `validateCat21BuyOfferPsbt` (seller-side).
 *
 * Before the seller signs an inbound buy-offer PSBT, the structure is checked
 * against the deal the seller actually agreed to. Any mismatch surfaces as a
 * typed `Cat21OfferRejectionReason` so the UI can render a precise reason
 * without leaking unrelated PSBT details.
 */
/**
 * Hard cap on the raw PSBT bytes passed to the validator. Mirrors the
 * `Cat21OperationGate`'s cap so non-Angular callers (cat21-wallet,
 * scripts) get the same protection. A real CAT-21 buy-offer is <1 KB;
 * 128 KiB is generous headroom while still blocking adversarial blobs.
 */
declare const MAX_BUY_OFFER_PSBT_BYTES: number;
interface ValidateCat21BuyOfferArgs {
    psbt: Uint8Array;
    expectedSellerUtxo: {
        txid: string;
        vout: number;
    };
    /** Minimum acceptable price in sats. Must be supplied; 0 is legal but the caller has to type it. */
    floorPriceSats: number;
    /**
     * REQUIRED. Without this, a malicious buyer can build a PSBT whose
     * Output 1 pays anywhere (including the buyer's own change), and the
     * validator only checks the amount, not the destination. The seller
     * would sign, the cat would move, and the payment would never arrive.
     * Made mandatory as of audit C1.
     */
    expectedSellerPaymentAddress: string;
    /**
     * Network used to decode Output 1's `scriptPubKey` back to an address.
     * Defaults to mainnet. Callers signing on testnet/regtest must pass it.
     */
    network?: Network;
}
/**
 * Validates the on-the-wire shape of an inbound buy-offer PSBT.
 *
 * **Scope rule — read this before adding a check:** this validator
 * protects the SELLER. "Whose loss is this?" — gate ONLY on things
 * that hurt the seller. Buyer-side optimization losses (no bonus-mint
 * cat from a missing `lockTime=21`, SIGHASH_DEFAULT-on-Taproot when
 * the buyer wanted SIGHASH_ALL, …) are NOT the seller's problem and
 * MUST NOT be grounds for rejection — a rejected offer is a lost sale.
 * See `feedback_validator_audience_check` memory.
 *
 *   1. Input 0 references the seller's cat UTXO.
 *   2. Every input has `sighashType === SIGHASH_ALL` (or undefined
 *      for already-finalised inputs — the embedded signature itself
 *      commits to its sighash).
 *   3. Every input 1..N carries a buyer signature (partialSig,
 *      tapKeySig, or finalScriptWitness).
 *   4. Output 0 (cat) postage ≥ configured minimum.
 *   5. Output 1 (seller payment) ≥ floor price.
 *   6. When `expectedSellerPaymentAddress` is supplied, Output 1's
 *      script is decoded and compared. Strongly recommended whenever
 *      a human eventually signs — the validator is the single source
 *      of truth and can't delegate to a UI layer that may or may
 *      not exist.
 */
declare function validateCat21BuyOfferPsbt(args: ValidateCat21BuyOfferArgs): Cat21OfferValidation;

/**
 * Layer-2 input adapter for the BUYER side of the CAT-21 buy-offer
 * flow.
 *
 * The buyer-initiated offer PSBT structurally has:
 *   - Input 0:  seller's cat UTXO (unsigned). The SELLER side
 *               doesn't go through this adapter — the buyer just
 *               references the seller's outpoint + scriptPubKey,
 *               learned out-of-band (marketplace, ord lookup, etc.).
 *   - Inputs 1..N: buyer's funding UTXOs. THIS adapter prepares
 *               those, dispatching via the address-format-driven
 *               `buildInputScript`.
 *
 * Pure function. No I/O, no Angular.
 */
interface PrepareBuyOfferBuyerInputArgs {
    utxo: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    isSimulation: boolean;
    network: Network;
}
declare function prepareBuyOfferBuyerInput(args: PrepareBuyOfferBuyerInputArgs): Cat21OfferBuyerInput;

/**
 * What the buyer needs to know about the cat they want to bid on.
 * Caller (typically a frontend) fetches this from ord: cat number →
 * inscription → current UTXO at the seller's address.
 *
 * The PSBT pre-populates input 0's `witnessUtxo` from these bytes so
 * the seller can sign offline without a round-trip — that's the
 * "buyer-initiated, sniping-proof" property of ord-style offers.
 */
interface BuyOfferTargetCat {
    catNumber: number;
    txid: string;
    vout: number;
    /** Always 546 sats for a CAT-21 cat UTXO; carried on the type for safety. */
    value: number;
    /** scriptPubKey of the seller's cat UTXO, raw bytes. */
    scriptPubKey: Uint8Array;
}
interface CreateOfferSimulation {
    vsize: number;
    feeSats: number;
    changeSats: number;
    buyerFundingUtxo: TxnOutput;
}
interface CreateOfferSimulationOutcome {
    simulation: CreateOfferSimulation | null;
    insufficient: boolean;
}
/**
 * State machine:
 *  - `idle` — no wallet connected.
 *  - `loading-utxos` — wallet just connected, fetching buyer's UTXOs.
 *  - `ready` — UTXOs loaded; form is interactive.
 *  - `signing` — user clicked Create; wallet is being asked to sign.
 *  - `success` — buyer-side signing finished; `offerArtifact()` carries
 *                the half-signed PSBT. **No broadcast** — the buyer's
 *                PSBT is incomplete (seller's input 0 stays unsigned).
 *  - `error` — something failed; `errorMessage` carries the reason.
 */
type CreateOfferState = 'idle' | 'loading-utxos' | 'ready' | 'signing' | 'success' | 'error';
/**
 * Buyer-side CAT-21 buy-offer construction. Produces the half-signed
 * PSBT a buyer shares with the cat's current owner.
 *
 * Per the workspace HARD RULE "Offers can be shared in the wild" the
 * artifact is NOT secret — the orchestrator emits bare base64 (and hex)
 * and the consumer is free to wrap it in any transport (URL, QR, gist).
 *
 * Per `validateCat21Operation`'s contract, all protocol invariants
 * (postage = 546, lockTime = 21, SIGHASH_ALL on every input) are
 * enforced INSIDE `buildCat21BuyOfferPsbt` — the orchestrator only
 * threads inputs and calls the builder.
 *
 * Singleton, signal-first. Mirrors Cat21TransferOrchestrator's wallet-
 * change reset semantics (wipe form on actual wallet swap; preserve
 * across BehaviorSubject re-emissions; defaults `buyerReceiveAddress`
 * to the connected wallet's ordinals address).
 */
declare class Cat21CreateOfferOrchestrator {
    private wallet;
    private cat21;
    private network;
    /** Which cat the buyer wants to bid on. */
    readonly targetCat: _angular_core.WritableSignal<BuyOfferTargetCat>;
    /** Where the seller wants payment (their own address; usually the seller's payment address). */
    readonly sellerPaymentAddress: _angular_core.WritableSignal<string>;
    /** Sats the buyer offers (this is the "ask" the seller's eventual payout output carries — `priceSats + CAT21_POSTAGE_SATS`). */
    readonly priceSats: _angular_core.WritableSignal<number>;
    /** Where the cat lands after the seller signs + broadcasts. Default = connected wallet's ordinals address. */
    readonly buyerReceiveAddress: _angular_core.WritableSignal<string>;
    readonly feeRate: _angular_core.WritableSignal<number>;
    private lastWalletAddress;
    private readonly priceSatsSubject;
    private readonly feeRateSubject;
    readonly state: _angular_core.WritableSignal<CreateOfferState>;
    readonly errorMessage: _angular_core.WritableSignal<string>;
    /**
     * The half-signed buy-offer PSBT (base64 + hex). Populated by
     * `createOffer()` on success. This IS the offer artifact the buyer
     * shares with the seller.
     */
    readonly offerArtifact: _angular_core.WritableSignal<{
        base64: string;
        hex: string;
    }>;
    readonly connectedWallet: _angular_core.Signal<WalletInfo>;
    readonly isReady: _angular_core.Signal<boolean>;
    /**
     * Auto-reset form fields when the wallet's ordinals address actually
     * changes. Field-init-order discipline as Cat21TransferOrchestrator
     * (BEFORE the derived streams below).
     */
    private readonly walletChangeSub;
    /**
     * Buyer's funding UTXOs (their payment address). The seller's cat
     * UTXO is at the seller's address — not in this list.
     */
    readonly buyerFundingUtxos$: Observable<TxnOutput[]>;
    readonly recommendedFees$: Observable<RecommendedFees>;
    /**
     * Two-pass fee simulation against the largest viable buyer UTXO.
     * Re-emits when target / price / funding / feeRate change.
     */
    readonly simulation$: Observable<CreateOfferSimulationOutcome>;
    setTargetCat(cat: BuyOfferTargetCat | null): void;
    setSellerPaymentAddress(address: string | null): void;
    setPriceSats(price: number): void;
    setBuyerReceiveAddress(address: string | null): void;
    setFeeRate(rate: number): void;
    /**
     * Build the buy-offer PSBT, ask the connected wallet to sign all
     * buyer inputs (1..N), and expose the result as `offerArtifact()`.
     * **Does NOT broadcast** — the offer is incomplete until the seller
     * signs input 0 in their own accept flow.
     */
    createOffer(): Observable<{
        base64: string;
        hex: string;
    }>;
    /**
     * Wipe form + result back to a fresh create-offer attempt. Keeps the
     * wallet connected; restores `buyerReceiveAddress` to the wallet's
     * ordinals address.
     */
    reset(): void;
    private lastFundingUtxosSnapshot;
    private readonly fundingUtxosSnapshotSub;
    private resetFormFields;
    private computeSimulation;
    private simulateOffer;
    private buildOfferPsbt;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<Cat21CreateOfferOrchestrator, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<Cat21CreateOfferOrchestrator>;
}

/**
 * The seller's view of a pasted offer PSBT after validation. Carries
 * the parsed details a UI surfaces in a "is this what you want to
 * accept?" panel before the user signs.
 */
interface ParsedOffer {
    /** Raw bytes of the (still buyer-signed-only) PSBT. */
    psbtBytes: Uint8Array;
    /** Cat being sold (txid:vout — sat 0 of this UTXO is the cat sat). */
    catUtxo: {
        txid: string;
        vout: number;
    };
    /** Buyer's payout — sats arriving at the seller's address. */
    pricePaidSats: number;
    /** 546 cat-postage that comes back to the seller's payout output. */
    postageSats: number;
}
/**
 * State machine for the seller-side accept-offer flow:
 *  - `idle` — nothing pasted yet.
 *  - `parsed` — paste decoded + validated successfully; seller can review.
 *  - `invalid` — paste decoded but failed validation (wrong cat, low price, missing sig).
 *  - `accepting` — wallet signing input 0; broadcast in flight.
 *  - `success` — broadcast OK; `successTxId` holds the txid.
 *  - `error` — something failed mid-accept; `errorMessage` holds the reason.
 */
type AcceptOfferState = 'idle' | 'parsed' | 'invalid' | 'accepting' | 'success' | 'error';
/**
 * Seller-side CAT-21 buy-offer accept. Pastes a base64 PSBT, validates
 * (right cat / right price / right address / sniping-proof shape),
 * lets the seller sign input 0, broadcasts.
 *
 * Validation uses `validateCat21BuyOfferPsbt` from the helper layer —
 * the seller's UI never reimplements protocol invariants.
 */
declare class Cat21AcceptOfferOrchestrator {
    private wallet;
    private cat21;
    private network;
    /** Offer artifact pasted by the seller (base64 or hex). */
    readonly pastedOffer: _angular_core.WritableSignal<string>;
    /**
     * Minimum price the seller is willing to accept. The orchestrator
     * REFUSES to validate until the consumer sets this explicitly — a
     * forgotten value would let any 1-sat offer pass the floor check.
     * No default. Use `setFloorPriceSats(0)` if you genuinely mean zero.
     */
    readonly floorPriceSats: _angular_core.WritableSignal<number>;
    /**
     * The cat the seller is selling (txid + vout). When set, validation
     * checks input 0 against this UTXO and rejects offers for the wrong
     * cat. UI typically derives this from the seller's selected cat-to-sell.
     */
    readonly expectedCatUtxo: _angular_core.WritableSignal<{
        txid: string;
        vout: number;
    }>;
    /**
     * The address the seller wants the payment to land at. When set,
     * validation rejects offers whose Output 1 (seller payment) doesn't
     * decode to this exact address. Strongly recommended; matches
     * `validateCat21BuyOfferPsbt`'s `expectedSellerPaymentAddress` arg.
     */
    readonly expectedSellerPaymentAddress: _angular_core.WritableSignal<string>;
    readonly state: _angular_core.WritableSignal<AcceptOfferState>;
    readonly errorMessage: _angular_core.WritableSignal<string>;
    readonly successTxId: _angular_core.WritableSignal<string>;
    /** Parsed + validated offer (set only when validation succeeds). */
    readonly parsedOffer: _angular_core.WritableSignal<ParsedOffer>;
    /**
     * Latest validation result (success or failure). Surfaces the typed
     * rejection reason in the UI without re-parsing.
     */
    readonly validationResult: _angular_core.WritableSignal<Cat21OfferValidation>;
    readonly connectedWallet: _angular_core.Signal<ordpool_sdk.WalletInfo>;
    readonly canAccept: _angular_core.Signal<boolean>;
    private lastWalletAddress;
    /**
     * Auto-reset paste + parse state when the wallet's ordinals address
     * actually changes. Field-init order before any derived stream
     * (none here, but kept for symmetry with the other orchestrators).
     */
    private readonly walletChangeSub;
    /**
     * Maximum acceptable paste size in bytes. PSBTs above this are rejected
     * before decoding to prevent OOM / tab-crash attacks via a malicious
     * `?offer=…` link. The on-chain shape of a real CAT-21 buy-offer is
     * <1 KB; 256 KiB is generous headroom for future protocol extensions
     * while still blocking DoS payloads.
     */
    static readonly MAX_PASTED_OFFER_BYTES: number;
    /**
     * Decode + validate the pasted offer. Sets `parsedOffer` + `validationResult`
     * + transitions `state` to `parsed` or `invalid`. Pure transition — no
     * wallet calls. Safe to call repeatedly as the user edits the paste.
     *
     * **Hardening:**
     * - Paste length capped at MAX_PASTED_OFFER_BYTES (audit finding C2).
     * - Validator only runs when `expectedSellerPaymentAddress` AND
     *   `floorPriceSats` are set (audit findings H1, H2). Without them
     *   the orchestrator stays in `idle` so the UI prompts the seller to
     *   complete the form before any wallet interaction.
     */
    setPastedOffer(paste: string | null): void;
    setFloorPriceSats(sats: number): void;
    /**
     * MAX_PASTED_OFFER_BYTES exposed for the UI's pre-paste textarea
     * `maxlength` attribute. Mirrors the static class field so consumers
     * don't need to reach for the constructor.
     */
    readonly maxPastedOfferBytes: number;
    setExpectedCatUtxo(utxo: {
        txid: string;
        vout: number;
    } | null): void;
    setExpectedSellerPaymentAddress(address: string | null): void;
    /**
     * Sign input 0 (the seller's cat UTXO) at the ordinals address and
     * broadcast. Requires a validated paste (`state === 'parsed'`) and
     * a connected wallet.
     */
    acceptOffer(): Observable<{
        txId: string;
    }>;
    /** Wipe paste + parse result. Keeps the wallet connected. */
    reset(): void;
    private resetFormFields;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<Cat21AcceptOfferOrchestrator, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<Cat21AcceptOfferOrchestrator>;
}

/**
 * Alias for {@link CAT21_POSTAGE_SATS}, kept for legacy import paths. The
 * canonical constant lives in `cat21-postage.ts`; every cat-touching tx
 * uses the same value across mint, transfer, and offer flows.
 */
declare const CAT21_TRANSFER_POSTAGE_SATS = 546;
/**
 * The cat-bearing UTXO the seller spends to move the cat. The first sat
 * of this UTXO carries the existing cat ordinal; per ordinal-theory
 * FIFO, it travels to the first sat of output 0.
 */
interface Cat21TransferCatInput {
    txid: string;
    vout: number;
    /** Sats locked in the cat-bearing UTXO. Usually 546. */
    value: number;
    /** scriptPubKey of the cat UTXO, raw bytes. */
    scriptPubKey: Uint8Array;
    /** For taproot inputs, the x-only internal public key. */
    tapInternalKey?: Uint8Array;
    /** For P2SH-wrapped SegWit (Xverse / Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /**
     * For legacy P2PKH inputs (Unisat-Legacy). Full previous-tx bytes —
     * scure refuses to sign legacy inputs from witnessUtxo alone.
     */
    nonWitnessUtxo?: Uint8Array;
}
/**
 * Wallet-provided funding UTXOs that pay the miner fee. Coin selection is
 * the caller's responsibility — the builder does NOT select. The caller
 * may also pass zero funding inputs if the cat UTXO itself has surplus
 * value above postage + fee.
 */
interface Cat21TransferFundingInput {
    txid: string;
    vout: number;
    value: number;
    scriptPubKey: Uint8Array;
    tapInternalKey?: Uint8Array;
    /** For P2SH-wrapped SegWit (Xverse / Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /**
     * For legacy P2PKH inputs (Unisat-Legacy). Full previous-tx bytes —
     * scure refuses to sign legacy inputs from witnessUtxo alone.
     */
    nonWitnessUtxo?: Uint8Array;
}
/** Output destinations of a CAT-21 transfer. */
interface Cat21TransferDestinations {
    /**
     * Where the cat lands. The first sat of this output receives the
     * existing cat AND — because `lockTime=21` is set — a fresh cat is
     * minted onto the same ordinal in the same tx.
     */
    recipientAddress: string;
    /** Where the sender's BTC change goes (when above dust). */
    senderChangeAddress: string;
}

/**
 * Dust threshold for the change output. 546 sats is the conservative
 * cross-address-type floor (taproot 330, segwit 294, p2sh 540 — 546
 * clears them all).
 */
declare const CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS = 546;
/**
 * Arguments for `buildCat21TransferPsbt`.
 *
 * Coin selection is the caller's responsibility. The builder structures
 * the PSBT and pins the protocol invariants; it does NOT pick UTXOs,
 * fetch them, or compute fees.
 */
interface BuildCat21TransferArgs {
    /**
     * Which wallet will sign this PSBT. Determines the input sequence:
     *   - `cat21wallet`: sequence = 0xfffffffd (RBF on; our accelerate
     *     flow preserves `lockTime=21` through replacement).
     *   - any other wallet: sequence = 0xfffffffe (RBF off; third-party
     *     accelerate UIs can't fire on this tx and accidentally drop
     *     the marker on replacement).
     */
    walletType: KnownOrdinalWalletType;
    network: Network;
    catUtxo: Cat21TransferCatInput;
    /**
     * Funding UTXOs that cover postage + fee above what the cat UTXO
     * already provides. May be empty when the cat UTXO is large enough
     * to self-fund.
     */
    fundingInputs: ReadonlyArray<Cat21TransferFundingInput>;
    destinations: Cat21TransferDestinations;
    /** Miner fee in sats. Caller computes from intended feeRate × vsize estimate. */
    feeSats: number;
}
interface BuildCat21TransferResult {
    /** Raw hex of the unsigned tx. */
    hex: string;
    /** Raw PSBT bytes. */
    psbt: Uint8Array;
    /** Total funding input value (sum of fundingInputs.value). 0 when self-funded. */
    fundingInputTotalSats: number;
    /** Change output value (0 when sub-dust; absorbed into fee). */
    changeSats: number;
}
/**
 * Builds the unsigned CAT-21 transfer PSBT.
 *
 * Every cat-touching tx we build is structurally a CAT-21 mint:
 * `lockTime=21` re-mints a fresh cat onto the same ordinal that
 * already carries the original — a single ordinal can carry multiple
 * cats. The value `21` is a protocol marker (block 21 mined in 2009),
 * no consensus meaning.
 *
 * Structure:
 *   Input 0  — cat-bearing UTXO. Cat's sat is the first sat of this
 *              UTXO; ends up at the first sat of output 0 (FIFO).
 *   Input 1+ — funding UTXOs (empty when the cat UTXO has surplus).
 *   Output 0 — recipient address, postage sats. Cat lands here.
 *   Output 1 — change (absorbed into fee when sub-dust).
 *
 * Hard invariants (asserted): lockTime=21, per-wallet sequence,
 * every input SIGHASH_ALL. Coin selection is the caller's job.
 */
declare function buildCat21TransferPsbt(args: BuildCat21TransferArgs): BuildCat21TransferResult;

/**
 * Layer-2 input adapter for the CAT-21 transfer pipeline.
 *
 * Address-format-driven: dispatches via `buildInputScript`. Works
 * for every wallet — the wallet identity is irrelevant to script
 * construction, only the payment address shape matters.
 *
 * Pure function. No I/O, no Angular.
 */
interface PrepareTransferInputArgs {
    utxo: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    isSimulation: boolean;
    network: Network;
}
declare function prepareTransferCatInput(args: PrepareTransferInputArgs): Cat21TransferCatInput;
declare function prepareTransferFundingInput(args: PrepareTransferInputArgs): Cat21TransferFundingInput;

/**
 * Identifies a cat the connected wallet currently owns. Consumer (the
 * cat21.space frontend or any other) populates this from its existing
 * "show me my cats" lookup (ord by ordinals address → list of cat
 * inscriptions → the UTXO each cat sits on).
 *
 * `vout` and `value` are intrinsic to CAT-21 (FIFO at output 0, 546
 * sats) but we carry them on the type so the orchestrator is self-
 * contained and a future protocol change wouldn't break the call
 * shape silently.
 */
interface Cat21Holding {
    catNumber: number;
    txid: string;
    vout: number;
    /** Always 546 sats for a CAT-21 cat UTXO. */
    value: number;
}
/**
 * Result of the per-fee-rate simulation. Either:
 * - `insufficient: true` — funding UTXOs can't cover postage + fee
 *   at the chosen rate. `simulation` is null.
 * - `insufficient: false` — viable; the simulation breakdown drives
 *   the "this is what'll happen" panel.
 */
interface TransferSimulation {
    vsize: number;
    feeSats: number;
    changeSats: number;
    fundingUtxo: TxnOutput;
}
interface TransferSimulationOutcome {
    simulation: TransferSimulation | null;
    insufficient: boolean;
}
/**
 * State machine the consumer's template branches on:
 *  - `idle` — no wallet connected.
 *  - `loading-utxos` — wallet just connected, fetching UTXOs from electrs.
 *  - `ready` — UTXOs loaded; form is interactive.
 *  - `transferring` — user clicked Transfer, PSBT being signed / broadcast.
 *  - `success` — broadcast OK; `successTxId` holds the txid.
 *  - `error` — something failed; `errorMessage` holds the reason.
 */
type TransferState = 'idle' | 'loading-utxos' | 'ready' | 'transferring' | 'success' | 'error';
/**
 * High-level CAT-21 transfer flow. Mirrors `Cat21MintOrchestrator` in
 * shape so consumers can drive both flows with identical state-machine
 * templates.
 *
 * Singleton (`providedIn: 'root'`); state persists across route
 * navigations within a session. Auto-resets writable inputs when the
 * connected wallet changes — the cat UTXOs aren't visible to a
 * different wallet, the funding UTXOs are gone, and the recipient the
 * user typed for the previous wallet shouldn't quietly carry forward.
 */
declare class Cat21TransferOrchestrator {
    private wallet;
    private cat21;
    private network;
    /** Which cat the user picked from their gallery. */
    readonly catUtxo: _angular_core.WritableSignal<Cat21Holding>;
    /** Where the cat should go after the transfer. */
    readonly recipientAddress: _angular_core.WritableSignal<string>;
    /** sat/vB from the fee picker or manual input. */
    readonly feeRate: _angular_core.WritableSignal<number>;
    private lastWalletAddress;
    private readonly catUtxoSubject;
    private readonly feeRateSubject;
    readonly state: _angular_core.WritableSignal<TransferState>;
    readonly errorMessage: _angular_core.WritableSignal<string>;
    readonly successTxId: _angular_core.WritableSignal<string>;
    /** Currently connected wallet bridged to a signal for template reads. */
    readonly connectedWallet: _angular_core.Signal<WalletInfo>;
    /** Convenience computed for `state() === 'ready'` gating. */
    readonly isReady: _angular_core.Signal<boolean>;
    /**
     * Auto-reset form fields when the wallet changes. Field-init order
     * matters: this subscription is declared BEFORE `fundingUtxos$` so
     * that `walletSubject.next(...)` notifies this handler FIRST,
     * clearing form state, and only then propagates through the loading
     * chain. Reverse order causes the form-reset to wipe a freshly-set
     * error message that the UTXO-fetch error path just wrote.
     *
     * Only the FORM is reset — not `errorMessage` or `successTxId`.
     * Operation-result state is owned by `transfer()` and `reset()`,
     * not by wallet-change events.
     */
    private readonly walletChangeSub;
    /**
     * Funding UTXOs for the connected wallet's payment address, with
     * the cat-bearing UTXO filtered out (we MUST NOT spend the cat as
     * funding — it has to ride input 0 of the transfer tx and end up
     * at output 0). Re-fetches on wallet change.
     */
    readonly fundingUtxos$: Observable<TxnOutput[]>;
    /**
     * Pass-through of the SDK's polled fee tiers. Mirrors mint's API.
     */
    readonly recommendedFees$: Observable<RecommendedFees>;
    /**
     * Best-funding-UTXO + two-pass-fee simulation for the current
     * (cat, fundingUtxos, recipient, feeRate) tuple. Re-emits when any
     * of those change. `insufficient: true` when no funding UTXO covers
     * `postage + fee`.
     */
    readonly simulation$: Observable<TransferSimulationOutcome>;
    setCatUtxo(cat: Cat21Holding | null): void;
    setRecipientAddress(address: string | null): void;
    setFeeRate(rate: number): void;
    /**
     * Trigger the transfer. Requires a connected wallet, a selected cat,
     * a recipient address, a fee rate, and a fundable funding UTXO.
     * Builds the PSBT, signs at both addresses, broadcasts.
     *
     * State transitions: ready → transferring → success | error.
     */
    transfer(): Observable<{
        txId: string;
    }>;
    /**
     * Wipe writables AND operation-result state back to a fresh
     * transfer (typically the "Transfer another" button on success).
     * Keeps the wallet connected.
     */
    reset(): void;
    /**
     * Latest snapshot of the funding UTXO list maintained by the
     * `fundingUtxos$` subscription. Lets `transfer()` synchronously
     * re-compute the simulation against the most recent UTXO set
     * without juggling RxJS take(1).
     */
    private lastFundingUtxosSnapshot;
    private readonly fundingUtxosSnapshotSub;
    private resetFormFields;
    private computeSimulation;
    /**
     * Build a dummy-signed transfer PSBT for fee/vsize measurement.
     * Uses the wallet's real public keys + addresses + script types
     * (so the witness shape and vsize match the real broadcast) but a
     * dummy fee placeholder per `twoPassFeeSimulation`'s contract.
     */
    private simulateTransfer;
    /**
     * Build the REAL unsigned transfer PSBT, using the pass-2 fee from
     * `simulation`. Caller hands the bytes to the wallet for signing.
     */
    private buildTransferPsbt;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<Cat21TransferOrchestrator, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<Cat21TransferOrchestrator>;
}

/**
 * Standard-relay weight ceiling — matches Bitcoin Core's
 * `MAX_STANDARD_TX_WEIGHT` (400 000 WU = 100 kvB). Above this the
 * public mempool rejects as non-standard and the dispatcher routes
 * to Slipstream (which bypasses standardness).
 *
 * Plain CAT-21 mints (~150 vB) never hit this. Slipstream is the
 * explicit fallback for oversize cases (large witness payload,
 * coin-consolidation alongside a mint, etc.).
 */
declare const STANDARD_TX_WEIGHT_LIMIT = 400000;
/**
 * Broadcast channel. `'slipstream'` is currently DORMANT — see
 * `slipstream.helper.ts`. No SDK consumer routes there today (every
 * CAT-21 flow we ship is ~150 vB and standard); the branch is kept
 * for future oversize-tx use cases.
 */
type Cat21BroadcastChannel = 'mempool' | 'slipstream';
interface Cat21BroadcastDecision {
    channel: Cat21BroadcastChannel;
    reason: string;
}
interface Cat21BroadcastInput {
    /** Raw transaction hex (signed + finalized). */
    hex: string;
    /** Tx weight in weight units. From `tx.weight` on `@scure/btc-signer`. */
    weight: number;
}
interface Cat21BroadcastOptions {
    /**
     * Force a specific channel regardless of weight. When omitted the
     * dispatcher uses `decideBroadcastChannel`.
     */
    forceChannel?: Cat21BroadcastChannel;
    signal?: AbortSignal;
    /** Slipstream base URL override. */
    slipstreamBaseUrl?: string;
    /** Allows tests + node-only environments to inject a fetch impl. */
    fetchImpl?: typeof fetch;
}
interface Cat21BroadcastResult {
    txid: string;
    channel: Cat21BroadcastChannel;
}
/**
 * # DORMANT — currently unused by any SDK consumer.
 *
 * Zero callers anywhere in the SDK or in cat21.space / ordpool. Every
 * cat-touching tx we ship (mint, transfer, buy-offer, accept-offer) is
 * ~150–250 vB and standard, so the dispatcher's only non-mempool branch
 * — `weight > STANDARD_TX_WEIGHT_LIMIT` → Slipstream — never fires.
 * `forceChannel: 'slipstream'` likewise has no caller. Slipstream itself
 * is DORMANT (see `slipstream.helper.ts`).
 *
 * Kept (not deleted) because the dispatcher is the natural shape for the
 * day a use case surfaces (large witness bundled with a cat, future
 * protocol experiments). Reviving this is cheaper than rebuilding it.
 *
 * **Before re-enabling**: re-verify the Slipstream contract per
 * `slipstream.helper.ts`, and confirm the mempool callback the consumer
 * supplies still resolves the right way (electrs POST `/tx`).
 *
 * Decision-only entry point — deterministic given the input + options,
 * no side effects.
 */
declare function decideBroadcastChannel(input: Cat21BroadcastInput, options?: Cat21BroadcastOptions): Cat21BroadcastDecision;
/**
 * # DORMANT — currently unused by any SDK consumer.
 *
 * The thin wrapper over `decideBroadcastChannel` + the mempool/Slipstream
 * branches. Every shipping cat-flow calls its broadcast callback
 * (electrs `POST /tx` via the ordpool backend) directly. See the dormancy
 * note on `decideBroadcastChannel`.
 *
 * The `broadcastViaMempool` callback is supplied by the consumer so the
 * SDK stays decoupled from any specific Esplora endpoint. The endpoint
 * is always **our own** electrs / ordpool backend — never mempool.space
 * (their API rejects our host by ban, and they're a competitor anyway;
 * see the workspace `CLAUDE.md` HARD RULE "Never call mempool.space from
 * shipping code").
 *
 * Failure mode: never silently retries. If Slipstream rejects, the caller
 * decides whether to fall back to the mempool callback. Auto-retry across
 * channels risks double-broadcast and is the caller's policy decision.
 */
declare function broadcastCat21(input: Cat21BroadcastInput, broadcastViaMempool: (hex: string) => Promise<string>, options?: Cat21BroadcastOptions): Promise<Cat21BroadcastResult>;

/**
 * # DORMANT — currently unused by any SDK consumer.
 *
 * Plain CAT-21 mints / transfers / offers are ~150 vB and standard, so
 * `decideBroadcastChannel` never routes here unless the caller passes
 * `forceChannel: 'slipstream'` or a tx exceeds `MAX_STANDARD_TX_WEIGHT
 * = 400 000`. Neither happens in any flow shipping today.
 *
 * Kept (not deleted) because the dispatcher pattern + the verified
 * Marathon contract are non-trivial to re-derive — when a use case
 * surfaces (oversize witness data bundled with cats, atomicals-like
 * payloads, future protocol experiments), reviving this helper is
 * cheaper than rebuilding it.
 *
 * **Before re-enabling**, re-verify the Marathon API contract with
 * curl probes (see the "verified" block below — the contract drifted
 * once already, both URL path and body field were wrong in an earlier
 * iteration). Bump the verification date in the docstring.
 *
 * # Background
 *
 * Marathon Slipstream is a direct-to-miner submission API. Useful when the
 * public mempool would policy-reject a transaction (oversize witness,
 * non-standard scripts, datacarrier above local limits). For plain CAT-21
 * mints the public mempool path is sufficient; Slipstream is the explicit
 * fallback for oversize cases.
 *
 * The base URL is the published one. Users running their own miner relay
 * (rare) can pass an override. There is no testnet endpoint; Slipstream is
 * mainnet-only.
 *
 * # API contract — verified 2026-06-15
 *
 * Endpoint:        POST https://slipstream.mara.com/api/transactions
 * Body:            `{ "tx_hex": "<hex-encoded-raw-tx>" }`
 * Auth:            Client code required (`Authorization: Bearer <token>`,
 *                  per the frontend bundle). Without a client code the
 *                  endpoint accepts the call up through deserialisation
 *                  but rejects the actual broadcast. Contact
 *                  foundation@mara.com to provision.
 *
 * Source of truth: derived by reading the Slipstream operator UI bundle
 * at `https://slipstream.mara.com/assets/index-T1J5o0ND.js`, which
 * defines `sx = "https://slipstream.mara.com"`,
 * `Pn = \`${sx}/api/\``, `Sl = \`${Pn}transactions\`` and the submit
 * function `(e) => Te.post(Sl, e).data`. Verified by curl probe on
 * 2026-06-15 17:07-08 UTC:
 *
 *     curl -X POST https://slipstream.mara.com/api/transactions \
 *          -H 'Content-Type: application/json' -d '{}'
 *     → 400 {"status":"error","message":"Invalid JSON payload"}
 *
 *     curl -X POST https://slipstream.mara.com/api/transactions \
 *          -H 'Content-Type: application/json' -d '{"tx_hex":"0100"}'
 *     → 400 {"status":"error","message":"Failed to deserialize transaction"}
 *
 *     curl -X POST https://slipstream.mara.com/api/transactions \
 *          -H 'Content-Type: application/json' -d '{"raw_transaction":"0100"}'
 *     → 400 {"status":"error","message":"Invalid JSON payload"}  // wrong field
 *
 *     curl https://slipstream.mara.com/api/v1/transactions
 *     → 404 Cannot POST /api/v1/transactions                     // wrong path
 *
 * Error response envelope: `{ status: "error", message: string }`.
 * Success response: `{ txid: string }` (frontend reads `(await Te.post
 * (Sl, e)).data.txid`).
 */
declare const SLIPSTREAM_DEFAULT_BASE_URL = "https://slipstream.mara.com";
/** Path component appended to the base URL for the submit endpoint. */
declare const SLIPSTREAM_SUBMIT_PATH = "/api/transactions";
/** JSON body field name carrying the raw tx hex. */
declare const SLIPSTREAM_BODY_TX_FIELD = "tx_hex";
/** Shape of the Slipstream submit success response. */
interface SlipstreamSubmitResponse {
    txid: string;
}
interface SubmitToSlipstreamOptions {
    /** Override base URL, e.g. for a self-hosted miner relay. */
    baseUrl?: string;
    /**
     * Bearer token issued by Marathon. Required for the broadcast to
     * actually fire — without it, the endpoint will accept the JSON +
     * deserialise the tx but the submission is rejected at the
     * authorisation gate. Contact foundation@mara.com to provision.
     */
    bearerToken?: string;
    signal?: AbortSignal;
    /**
     * `fetch` impl. Defaults to the global `fetch`. Allows tests + Node
     * environments without a configured global to inject a polyfill.
     */
    fetchImpl?: typeof fetch;
}
/**
 * Submit a single raw transaction (hex) to Slipstream. Returns the txid the
 * miner relay accepted, which is also the txid the network will see.
 *
 * Throws on non-2xx OR on a response body without a `txid` string. The
 * caller is expected to either fall back to standard mempool broadcast OR
 * surface the error — never to retry blindly, since Slipstream submissions
 * can be expensive and may double-broadcast if the caller is not careful.
 *
 * Uses `fetch + AbortController` (no axios per SDK convention).
 */
declare function submitToSlipstream(rawTxHex: string, options?: SubmitToSlipstreamOptions): Promise<SlipstreamSubmitResponse>;

/**
 * Ord-protocol field tags. Mirrors ordpool-parser's `knownFields`
 * value-for-value. See https://docs.ordinals.com/inscriptions.html
 * for the canonical reference.
 */
declare const ORD_TAGS: {
    /** MIME type of the body. */
    readonly content_type: 1;
    /** Override placement on a sat other than the first. */
    readonly pointer: 2;
    /** Parent inscription id for provenance chains. */
    readonly parent: 3;
    /** CBOR-encoded metadata. */
    readonly metadata: 5;
    /** Metaprotocol identifier string. */
    readonly metaprotocol: 7;
    /** Body encoding hint (`br` for brotli). */
    readonly content_encoding: 9;
    /** Delegate inscription id (point to another inscription's body). */
    readonly delegate: 11;
    /** Rune-name commitment for rune etching pre-commit. */
    readonly rune: 13;
    /** Reserved Tag::Note; de facto inscriber-tool watermark. */
    readonly note: 15;
    /** CBOR-encoded gallery items + attributes. */
    readonly properties: 17;
    /** Encoding for properties (`br` for brotli). */
    readonly property_encoding: 19;
};
type OrdTag = typeof ORD_TAGS[keyof typeof ORD_TAGS];
/**
 * A single tag/value pair embedded in the envelope before the body.
 * The encoder serialises each as `<tag-push> <value-push>`.
 */
interface OrdEnvelopeField {
    tag: OrdTag;
    value: Uint8Array;
}
interface BuildInscriptionEnvelopeArgs {
    /**
     * x-only Schnorr pubkey (32 bytes) that signs the reveal. Embedded
     * AFTER the envelope as `<pubkey> OP_CHECKSIG` — the actual
     * spending condition. The envelope itself sits inside a dead
     * `OP_FALSE OP_IF ... OP_ENDIF` branch and is never executed.
     */
    revealPubkeyXonly: Uint8Array;
    /**
     * MIME type encoded as UTF-8 bytes. Encoded as tag 1
     * (`content_type`).
     */
    contentType?: string;
    /**
     * Body bytes (raw inscription content). Sliced into 520-byte
     * pushes after the OP_0 separator. Pass an empty Uint8Array for
     * inscriptions whose body lives elsewhere (delegate, metadata-only).
     */
    body: Uint8Array;
    /**
     * Additional tags (parent, metadata, metaprotocol, etc.). Order
     * is preserved in the encoded envelope but order doesn't affect
     * the on-chain inscription's resolved fields — ord's decoder
     * indexes by tag, not position.
     */
    fields?: ReadonlyArray<OrdEnvelopeField>;
}
/**
 * Builds the inscription tapscript: the bytes that hash into a
 * tapscript leaf on the commit address, and that the reveal tx
 * provides as witness when spending via the envelope leaf.
 *
 * Structure (per ord protocol):
 *
 * ```
 * <revealPubkeyXonly>                    (32-byte push)
 * OP_CHECKSIG
 * OP_FALSE                               (0x00)
 * OP_IF                                  (0x63)
 *   "ord"                                (3-byte push)
 *   [for each field:]
 *     <tag>                              (OP_N for tag ≤ 16, else 1-byte push)
 *     <value>                            (variable push)
 *   OP_0                                 (separator before body)
 *   [for each body chunk (≤ 520 bytes):]
 *     <chunk>
 * OP_ENDIF                               (0x68)
 * ```
 *
 * The `OP_FALSE OP_IF ... OP_ENDIF` block is provably-dead code:
 * script execution never enters the IF branch because the top of
 * stack is OP_FALSE. The bytes are still committed to in the
 * tapleaf hash, which is what carries the inscription on-chain.
 * The actual spending check is the `<pubkey> OP_CHECKSIG` PREFIX,
 * which ord's protocol places before the dead envelope.
 *
 * Returns the encoded tapscript bytes ready for taproot leaf
 * inclusion via `btc.p2tr(..., { script, leafVersion: 0xc0 })`.
 */
declare function buildInscriptionEnvelope(args: BuildInscriptionEnvelopeArgs): Uint8Array;

/**
 * Layer-1 builder for the inscribe **commit** transaction.
 *
 * Construction outline:
 *
 *   1. The reveal spends a P2TR output with a **single envelope leaf**.
 *      The **ephemeral key** is the taproot internal key — so the
 *      commit output has two equivalent spend paths:
 *        a. Script-path via the envelope leaf (used by the standard
 *           reveal — emits the inscription).
 *        b. Key-path via the ephemeral key (used by any redirect /
 *           RBF / recover / bundle reveal the consumer constructs
 *           after `createInscribeTransactions` returns).
 *      Same shape as Casey Rodarmor's `ord` reference client
 *      (`src/wallet/batch/plan.rs` lines 367-382). The ephemeral key
 *      doubles as a bearer instrument: whoever holds it can build
 *      any reveal-tx shape until the commit output is spent.
 *
 *   2. The commit transaction has:
 *        - 1 funding input (caller-supplied UTXO; user's wallet
 *          signs)
 *        - Output 0: the commit P2TR address holding
 *          `postage + revealFeeReserve`. The reveal spends this.
 *        - Output 1 (optional): change back to the user, if the
 *          funding input has surplus above commit fee + output 0.
 *
 * Returns the unsigned commit PSBT bytes + the metadata the
 * reveal builder needs to construct the spending witness.
 */
/**
 * Canonical postage for inscriptions. Same 546-sat dust floor as
 * cat21 — keeps inscription UTXOs fungible across address types
 * AND matches the floor every inscriber in the OSS catalog uses.
 * See HQ rule "cat UTXO is always 546 sats, FIFO".
 */
declare const INSCRIBE_POSTAGE_SATS = 546;
interface InscribeCommitArgs {
    /** Funding UTXO the user's wallet will sign. */
    fundingInput: {
        txid: string;
        vout: number;
        value: number;
        scriptPubKey: Uint8Array;
        /** Set on P2TR funding inputs. Same shape as the cat21 mint adapter. */
        tapInternalKey?: Uint8Array;
        /** Set on P2SH-wrapped funding (Xverse Nested SegWit etc.). */
        redeemScript?: Uint8Array;
        /** Set on legacy P2PKH funding. */
        nonWitnessUtxo?: Uint8Array;
    };
    /** Address the user's change returns to (taproot output of the funding wallet). */
    senderChangeAddress: string;
    /** Tapscript bytes for the envelope leaf (output of `buildInscriptionEnvelope`). */
    envelopeScript: Uint8Array;
    /**
     * 32-byte x-only ephemeral public key. Doubles as:
     *   - The first push inside the envelope script (`<pubkey>
     *     CHECKSIG OP_FALSE OP_IF "ord" …`).
     *   - The taproot internal key of the commit output.
     * Holding the matching private key authorises any reveal-tx
     * shape the consumer wants to build (default reveal, redirect,
     * RBF, recover-to-self, bundle).
     */
    ephemeralPubkeyXonly: Uint8Array;
    /** Commit-tx fee in sats (built by the fee helper at Layer 3). */
    commitFeeSats: number;
    /** Reveal-tx fee in sats (reserved in commit output 0 for the reveal to pay). */
    revealFeeReserveSats: number;
    /**
     * Optional tip-output amount in sats reserved on the commit output
     * (in addition to postage + revealFeeReserve). The tip output itself
     * lives on the reveal tx at vout[1]; this is just the bookkeeping
     * the commit needs to fund it.
     *
     * When set, `commitOutputValueSats = postage + revealFeeReserve +
     * tipValueSats`; when omitted the commit output sizes exactly as
     * before. Must be a non-negative integer.
     */
    tipValueSats?: number;
    /** Per-address-type change dust limit; below this the change is absorbed into the fee. */
    changeDustLimitSats?: number;
    network: Network;
}
interface InscribeCommitResult {
    /** Unsigned PSBT bytes ready for the user's wallet to sign. */
    commitPsbt: Uint8Array;
    /** Bech32m P2TR address the reveal will spend from. */
    commitAddress: string;
    /** scriptPubKey bytes of the commit output (same script the reveal references). */
    commitOutputScript: Uint8Array;
    /** Sat value the commit places at output 0 (postage + revealFeeReserve). */
    commitOutputValueSats: number;
    /** Taptree metadata the reveal builder needs to construct its spending witness. */
    taproot: {
        /** Taproot internal key actually written to the output (the ephemeral pubkey). */
        internalKey: Uint8Array;
        /**
         * scure's tapLeafScript array — single entry, for the envelope leaf.
         * The reveal builder passes this straight to the script-path reveal;
         * a key-path reveal doesn't need it.
         */
        tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
    };
    /** Change amount on output 1; 0 when sub-dust (absorbed into the fee). */
    changeSats: number;
}
declare function buildInscribeCommitPsbt(args: InscribeCommitArgs): InscribeCommitResult;

/**
 * Layer-1 builder for the **reveal** transaction.
 *
 * The reveal:
 *   - Spends the commit's P2TR output (built by the commit helper)
 *     via the envelope tapscript leaf.
 *   - Witness shape: `[ephemeralSig, envelopeScript, controlBlock]`.
 *   - Has one output at index 0: `recipientAddress` for postage sats.
 *     Per ord theory, the inscription lands on the first sat of the
 *     first output.
 *
 * The reveal hex is self-contained: signed under the ephemeral
 * key, replayable, idempotent, broadcast-from-anywhere. The
 * orchestrator passes the ephemeral key here AND returns it on
 * `CreateInscribeTransactionsResult.ephemeral.privKey` so the
 * consumer can rebuild a different reveal later (redirect, RBF,
 * recover-to-self, bundle) without losing access.
 */
/** Result of `buildInscribeRevealTx`. */
interface InscribeRevealResult {
    /** Network-serialised, finalized reveal tx (hex). */
    revealHex: string;
    /** Computed txid of the reveal. */
    revealTxid: string;
    /** vsize of the finalized reveal (used by the fee helper). */
    revealVsize: number;
}
interface InscribeRevealArgs {
    /** Commit txid (caller broadcasts commit later; we just reference it). */
    commitTxid: string;
    /** Commit output index — always 0 for the inscriber. */
    commitVout: number;
    /** Sat value at the commit output (postage + revealFeeReserve). */
    commitOutputValueSats: number;
    /** scriptPubKey bytes of the commit output (output of commit helper). */
    commitOutputScript: Uint8Array;
    /** Taptree spend metadata (output of commit helper). */
    taproot: {
        internalKey: Uint8Array;
        tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
    };
    /**
     * 32-byte ephemeral private key. SAME key whose Schnorr x-only
     * pubkey was embedded in the envelope script the commit helper
     * placed in the taptree. The Layer-4 orchestrator generates this
     * once, hands it to the envelope builder (via `deriveRevealPubkeyXonly`)
     * AND here, then zeros it. Mismatched key → scure rejects finalize.
     */
    ephemeralPrivKey: Uint8Array;
    /** Address the inscription lands on (P2TR recommended). */
    recipientAddress: string;
    /**
     * Optional tip output appended at vout[1] of the reveal. The
     * inscription MUST stay at vout[0] (ord's "first sat of first
     * output" rule), so the tip lives one slot below. When omitted,
     * the reveal has its single recipient output as before.
     *
     * Caller is responsible for ensuring `commitOutputValueSats`
     * carries enough sats to fund postage + reveal fee + tip.value;
     * the fee simulator's `tip` param threads that through.
     */
    tip?: {
        address: string;
        value: number;
    };
    /** Network. */
    network: Network;
}
/**
 * Signs the reveal via the envelope tapscript leaf, returns the
 * finalized reveal hex. The caller-supplied ephemeral private key
 * is used for the Schnorr signature; the orchestrator returns this
 * same key on its result so the consumer can rebuild a different
 * reveal later under different parameters.
 */
declare function buildInscribeRevealTx(args: InscribeRevealArgs): InscribeRevealResult;
/**
 * Derives the x-only Schnorr pubkey from a private key. The pubkey
 * is what gets embedded in the envelope tapscript via
 * `<revealPubkeyXonly> OP_CHECKSIG`, so the caller can pre-compute
 * the envelope independently of the actual reveal call. The same
 * pubkey is fed to both the commit helper (via envelopeScript) and
 * the reveal helper (implicitly via the regenerated private key).
 *
 * Returns the 32-byte x-only Schnorr pubkey.
 */
declare function deriveRevealPubkeyXonly(privKey: Uint8Array): Uint8Array;

/**
 * Layer-2 input adapter for the CAT-21 inscribe pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the funding-input shape that
 * `buildInscribeCommitPsbt` consumes.
 *
 * Address-format-driven via `buildInputScript` — universal dispatch
 * across all wallet variants the SDK supports. Wallet identity is
 * irrelevant; only the payment address shape matters. Mirrors
 * `prepareMintInputForWallet` (the cat21 mint adapter) line-for-line.
 *
 * Pure function. No I/O, no Angular.
 */
interface InscribeFundingInput {
    txid: string;
    vout: number;
    value: number;
    scriptPubKey: Uint8Array;
    /** Set on P2TR funding inputs (Unisat-Taproot, Xverse-Taproot, etc.). */
    tapInternalKey?: Uint8Array;
    /** Set on P2SH-wrapped funding (Xverse Nested SegWit, Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /** Set on legacy P2PKH funding — scure requires full prev-tx bytes. */
    nonWitnessUtxo?: Uint8Array;
}
interface PrepareInscribeFundingInputArgs {
    utxo: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    isSimulation: boolean;
    network: Network;
}
declare function prepareInscribeFundingInput(args: PrepareInscribeFundingInputArgs): InscribeFundingInput;

/**
 * Layer-3 fee simulation for the inscribe commit + reveal pair.
 *
 * The two transactions pay independent fees at the same `feeRate`:
 *
 *   commit_fee = ceil(commitVsize × feeRate)
 *   reveal_fee = ceil(revealVsize × feeRate)
 *
 * The reveal's vsize is **deterministic given the envelope** (input
 * = commit output, output = recipient at postage, witness =
 * envelope script + Schnorr sig + control block) so we compute it
 * once via a one-shot simulation. The commit's vsize depends on
 * whether the change output crosses the dust limit at the
 * resolved fee, so we run the cat21-style two-pass loop on the
 * commit alone, passing `revealFeeReserveSats = reveal_fee`.
 *
 * Net cost: 1 reveal simulation + 2 commit simulations = 3 builds.
 *
 * Universal fee strategy that matches every inscriber in the
 * verified OSS catalog (ord client, micro-ordinals examples,
 * oyl-sdk, ordit-sdk, 0xFlicker, LaserEyes — see
 * OSS-INSCRIBERS.md). No zero-fee tricks, no CPFP magic; the
 * atomicity story is `submitpackage` at broadcast time, which
 * handles its own package-feerate math.
 */
interface SimulateInscribeFeesArgs {
    /** sat/vB target fee rate. Same rate applies to both commit + reveal. */
    feeRatePerVbyte: number;
    /** Inscription body bytes. Shape-determines reveal vsize. */
    body: Uint8Array;
    /** MIME type encoded into the envelope. */
    contentType?: string;
    /** Optional extra envelope fields (parent, metaprotocol, metadata...). */
    envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
    /**
     * Funding-input shape — the same `InscribeFundingInput` the commit
     * helper consumes. The Layer-2 adapter produces this.
     */
    fundingInput: InscribeCommitArgs['fundingInput'];
    /** Where the user's change returns to. */
    senderChangeAddress: string;
    /** Where the inscription lands. */
    recipientAddress: string;
    /**
     * 32-byte x-only ephemeral pubkey used as the taproot internal key
     * AND embedded in the envelope's `<pubkey> CHECKSIG` prefix. Real
     * orchestrator passes the freshly-generated key; specs may pass a
     * deterministic dummy because vsizes don't depend on key bytes.
     */
    ephemeralPubkeyXonly: Uint8Array;
    /**
     * Optional reveal-tx tip output. Threads through to the reveal
     * vsize estimate (extra output bytes) AND the commit's
     * `tipValueSats` so the commit funds postage + revealFee + tip.
     */
    tip?: {
        address: string;
        value: number;
    };
    /** Per-address-type dust limit for the commit change. */
    changeDustLimitSats?: number;
    network: Network;
}
interface SimulateInscribeFeesResult {
    /** Final commit-tx fee in sats. */
    commitFeeSats: number;
    /** Final reveal-tx fee in sats. */
    revealFeeSats: number;
    /** commitFeeSats + revealFeeSats. The "total fee burden" for UI display. */
    totalFeeSats: number;
    /** Commit vsize at final fee. */
    commitVsize: number;
    /** Reveal vsize (deterministic given the envelope). */
    revealVsize: number;
    /** commitVsize + revealVsize. Useful for package-feerate math. */
    combinedVsize: number;
    /** Amount the commit output 0 holds = postage + revealFeeSats. */
    commitOutputValueSats: number;
    /** Total sats the funding UTXO must cover: commitOutputValueSats + commitFeeSats. */
    fundingRequirementSats: number;
}
/**
 * Returns the commit + reveal fee math at the given fee rate.
 * Pure function — does not broadcast, does not retain any key
 * material between calls.
 */
declare function simulateInscribeFees(args: SimulateInscribeFeesArgs): SimulateInscribeFeesResult;

/**
 * Layer-4 orchestration entry: ties the envelope encoder + per-
 * wallet input adapter + commit/reveal builders + fee simulator
 * into a single createTransaction-style entry point.
 *
 * Mirrors `createTransaction` from `cat21.service.helper.ts`. The
 * caller hands in the funding UTXO + wallet payment context + the
 * inscription content + feeRate; we hand back an unsigned commit
 * PSBT + a default signed reveal hex + the **ephemeral key material**
 * needed to build any other reveal shape (redirect, RBF, recover-
 * to-self, bundle).
 *
 * # Lifecycle
 *
 *  1. Generate fresh ephemeral keypair (32 random bytes).
 *  2. Derive Schnorr x-only pubkey — this doubles as the envelope's
 *     `<pubkey> CHECKSIG` prefix AND the taproot internal key of the
 *     commit output.
 *  3. Build envelope with that pubkey + caller's content.
 *  4. Simulate fees (Layer 3): commitFee, revealFee,
 *     commitOutputValueSats, fundingRequirementSats.
 *  5. Build the commit PSBT at the resolved commitFee.
 *  6. Build a default reveal tx at the resolved revealFee using the
 *     ephemeral private key (recipient = `args.recipientAddress`).
 *  7. Return the ephemeral key material so the caller can re-build
 *     the reveal under different parameters later if it wants to.
 *
 * # Bearer-key semantic
 *
 * `ephemeral.privKey` is a **bearer instrument**: anyone who holds
 * it can spend the commit output (redirect the inscription, RBF the
 * reveal, recover the postage to themselves, ...) until the commit
 * output is spent on chain. Treat it with the same care as any
 * other money-bearing key:
 *
 *   - Phase 1 storage: `localStorage` keyed by `commitTxid` is fine
 *     for typical low-value inscriptions. The key lives only
 *     between commit broadcast and reveal broadcast (seconds to
 *     hours typically).
 *   - For higher-value flows, encrypt at rest with the wallet
 *     password — same posture as any other hot key.
 *   - Lose the key with no reveal broadcast and the postage is
 *     permanently locked. Save it before discarding the result.
 *
 * This is byte-equivalent to the `ord` reference client's design
 * (`src/wallet/batch/plan.rs` lines 367-382 + 676-709) — ord
 * persists the ephemeral key into Bitcoin Core's wallet under a
 * `commit tx recovery key` label; we hand it to the consumer to
 * persist however it wants.
 */
interface CreateInscribeTransactionsArgs {
    /** Funding UTXO. */
    paymentOutput: TxnOutput;
    /** Wallet's payment public key (33-byte compressed). */
    paymentPublicKey: Uint8Array;
    /** Wallet's payment address (where change returns). */
    paymentAddress: string;
    /** Where the inscription lands (P2TR recommended for ord theory). */
    recipientAddress: string;
    /** Inscription body bytes. */
    body: Uint8Array;
    /** MIME type. */
    contentType?: string;
    /** Optional extra ord tags (parent, metaprotocol, metadata...). */
    envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
    /** sat/vB target. Applied identically to commit + reveal. */
    feeRatePerVbyte: number;
    /**
     * Optional tip output appended at vout[1] of the reveal tx. The
     * inscription stays at vout[0] per ord's first-sat-of-first-output
     * rule. The commit's funding requirement grows by `tip.value` so
     * the reveal has the sats to fund the extra output.
     *
     * The SDK ships no default tip address — consumers (ordpool.space,
     * cat21.space, future inscribers) wire their own default. Pattern
     * mirrors `0xFlicker/ordinals`' `feeDestinations`, simplified to
     * one recipient and a fixed sats amount.
     */
    tip?: {
        address: string;
        value: number;
    };
    /** Network. */
    network: Network;
}
interface CreateInscribeTransactionsResult {
    /** Unsigned commit PSBT — hand to the user's wallet for signing. */
    commitPsbt: Uint8Array;
    /**
     * Computed txid of the commit. SegWit txids are witness-independent,
     * so this matches what the wallet-signed commit will produce.
     */
    commitTxid: string;
    /** Signed, finalized reveal-tx hex. Self-contained; broadcast as-is. */
    revealHex: string;
    /** Computed txid of the reveal (lets consumers display/track before broadcast). */
    revealTxid: string;
    /** Commit-tx P2TR address (bech32m). */
    commitAddress: string;
    /** Final fees (sats), vsizes, and the funding requirement. */
    fees: SimulateInscribeFeesResult;
    /**
     * Ephemeral bearer key for the commit output. Authorises any
     * reveal-tx shape (default reveal, redirect, RBF, recover-to-
     * self, bundle) until the commit output is spent. SAVE BEFORE
     * DISCARDING THIS RESULT — losing the key with no reveal
     * broadcast locks the postage forever.
     */
    ephemeral: {
        /** 32-byte Schnorr private key. */
        privKey: Uint8Array;
        /** 32-byte x-only public key. Same key embedded in the envelope. */
        pubkeyXonly: Uint8Array;
    };
    /** Material the caller needs to rebuild the reveal tx under different parameters. */
    commit: {
        /** Commit output scriptPubKey. */
        outputScript: Uint8Array;
        /** Postage + revealFeeReserve at the commit output. */
        outputValueSats: number;
        /** Envelope tapscript bytes (the leaf the reveal spends through). */
        envelopeScript: Uint8Array;
    };
}
/**
 * Build the inscribe commit + reveal pair for the given content.
 * Pure function modulo `randomPrivateKey`.
 *
 * The returned `ephemeral.privKey` is the bearer instrument for
 * the commit output — see the module-level lifecycle note for the
 * storage semantic.
 */
declare function createInscribeTransactions(args: CreateInscribeTransactionsArgs): CreateInscribeTransactionsResult;

/**
 * Inscribe broadcast helper.
 *
 * Phase-1 strategy (per the locked-in design decisions in
 * `OSS-INSCRIBERS.md`):
 *
 *  - The inscribe pipeline produces a (commit, reveal) tx pair. The
 *    two MUST land atomically: a confirmed commit without a known
 *    reveal stalls the wallet's recovery flow; a reveal that
 *    references an un-broadcast commit is rejected with
 *    `missing-inputs`.
 *  - Bitcoin Core v28+ exposes `submitpackage` (BIP-331) for atomic
 *    1-parent-1-child submission. ordpool-electrs already speaks
 *    `POST /txs/package` (`rest.rs:1544`); we POST the pair there.
 *  - We do NOT trust a single endpoint. Phase 1 fans out the package
 *    to BOTH our own electrs (`ord.ordpool.space` / `api.ordpool.space`)
 *    and blockstream's `/txs/package` in PARALLEL. The first 2xx
 *    wins; the second response is logged but does not influence the
 *    return. "Our job is done" the moment one endpoint reports
 *    acceptance.
 *  - Per `OSS-INSCRIBERS.md` Q1+Q2: no journal, no retry. The
 *    ephemeral key is zeroed in `createInscribeTransactions` BEFORE
 *    this helper runs; if both endpoints reject the package, the
 *    inscription is unrecoverable from this process and the caller
 *    surfaces a final error to the user.
 *  - `testmempoolaccept` is intentionally NOT pre-flighted. The
 *    real submission IS the test; pre-flighting doubles request
 *    volume for no benefit (acceptance has the same edge cases
 *    either way, and a successful pre-flight does not guarantee
 *    a successful broadcast moments later when mempool state
 *    changes).
 *
 * No Slipstream branch yet. Standard-weight inscriptions
 * (≤350 KB body → reveal stays under MAX_STANDARD_TX_WEIGHT)
 * land via public mempool; oversized payloads are a Phase-3
 * concern.
 */
/**
 * Default fan-out endpoints. Both speak BIP-331 `submitpackage`
 * over an Esplora-compatible `/txs/package` POST.
 *
 * Order is by preference (ours first), but the helper POSTs to
 * ALL endpoints concurrently — the order only matters for the
 * `reason` field in the response if multiple endpoints succeed
 * simultaneously.
 */
declare const DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS: ReadonlyArray<string>;
/** Single per-endpoint outcome. */
interface InscribePackageEndpointResult {
    endpoint: string;
    ok: boolean;
    /** HTTP status code when the endpoint responded; -1 when the request itself failed. */
    status: number;
    /** Body text on accept (typically the commit txid) or error text on reject. */
    body: string;
}
interface InscribePackageBroadcastInput {
    /** Commit tx hex (signed + finalized by the user's wallet). */
    commitHex: string;
    /** Reveal tx hex (already finalized by the orchestrator with the ephemeral key). */
    revealHex: string;
    /**
     * Pre-computed weight of the (commit + reveal) pair. Used only to
     * surface a structured error when the package is too heavy for
     * standard relay; we DON'T silently route to Slipstream from here.
     */
    packageWeight?: number;
}
interface InscribePackageBroadcastOptions {
    /** Override the default endpoints. The helper POSTs to all in parallel. */
    endpoints?: ReadonlyArray<string>;
    signal?: AbortSignal;
    /** Per-request timeout in milliseconds. Default: 15s. */
    perEndpointTimeoutMs?: number;
    /** Allows tests + node-only environments to inject a fetch impl. */
    fetchImpl?: typeof fetch;
}
interface InscribePackageBroadcastResult {
    /**
     * True iff AT LEAST one endpoint reported HTTP 2xx. Per the Phase-1
     * design ("our job is done when at least one endpoint accepts"),
     * this is the only field consumers need to branch on.
     */
    ok: boolean;
    /**
     * Per-endpoint outcomes. Useful for surfacing degraded states
     * ("the package landed on ordpool but blockstream rejected with
     * `txn-mempool-conflict`") without changing the consumer's
     * primary success path.
     */
    endpointResults: ReadonlyArray<InscribePackageEndpointResult>;
}
/**
 * POST the (commit, reveal) package to every configured endpoint in
 * parallel and resolve when each endpoint has either responded or
 * timed out.
 *
 * Never throws. A network failure on every endpoint manifests as
 * `{ ok: false, endpointResults: [...] }` so the caller's error path
 * stays inside a discriminated union.
 *
 * # Endpoint contract
 *
 *  - `POST <endpoint>/txs/package`
 *  - Body: JSON array of hex strings, parent first then child:
 *    `[commitHex, revealHex]`. Matches ordpool-electrs's parser at
 *    `rest.rs:1544` and the BIP-331 `submitpackage` shape Core uses.
 *  - 2xx response → accepted. Body is implementation-specific
 *    (electrs returns the parent txid; Core's mempool returns a
 *    structured JSON object). We don't parse it — acceptance is
 *    the signal, body is for diagnostics.
 *  - Non-2xx → rejected. Body is the error text for diagnostics.
 *
 * The function never aborts the slow endpoint when the fast one
 * succeeds. We want diagnostic data from both. The price is a
 * brief wait for the slow endpoint or its timeout; in practice
 * sub-second.
 */
declare function broadcastInscribePackage(input: InscribePackageBroadcastInput, options?: InscribePackageBroadcastOptions): Promise<InscribePackageBroadcastResult>;

/**
 * Public orchestrator for the inscribe operation. Build commit +
 * reveal, ask the user's wallet to sign the commit's funding input
 * via the operation-named `signSingleFundingInput`, broadcast both
 * txs in sequence, return the ephemeral key + txids.
 *
 * # Why one entry point, no signingMap
 *
 * The inscribe commit has a single input at `paymentAddress`,
 * SIGHASH_ALL — same topology as a cat21 mint. The signer's
 * `signSingleFundingInput` enforces that shape; the consumer cannot
 * pass a signingMap that asks for anything else.
 *
 * # Bearer key
 *
 * The ephemeral private key is returned on `result.ephemeral.privKey`.
 * Anyone holding it controls the commit output (redirect, RBF,
 * recover-to-self, bundle) until the commit output is spent. Persist
 * with whatever security posture matches the inscription value;
 * localStorage keyed by `commitTxId` is fine for typical low-value
 * inscriptions, encrypt-at-rest with the wallet password for
 * higher-value flows. See `inscription.service.helper.ts` module
 * doc for the full bearer-key semantic.
 *
 * # Broadcast model
 *
 * Default: sequential. Sign commit → broadcast commit → broadcast
 * reveal. Each broadcast goes through the same `broadcast` callback
 * the consumer supplies (typically `electrs POST /tx`).
 *
 * For atomic submitpackage broadcast, see `broadcastInscribePackage`
 * in `inscribe-broadcast.helper.ts` — the consumer can capture the
 * signed commit hex from this orchestrator's `onCommitSigned`
 * callback and POST both hexes to `/txs/package` instead. The
 * orchestrator itself stays simple.
 */
interface InscribeAndBroadcastArgs {
    walletType: KnownOrdinalWalletType;
    paymentOutput: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    recipientAddress: string;
    body: Uint8Array;
    contentType?: string;
    envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
    feeRatePerVbyte: number;
    /**
     * Optional tip output appended at vout[1] of the reveal. SDK
     * ships no default address — consumers wire their own. See
     * `createInscribeTransactions` for the full semantic.
     */
    tip?: {
        address: string;
        value: number;
    };
    network: Network;
    /**
     * Broadcasts a wire-format tx hex; returns the resulting txid.
     * Called twice: once with the wallet-signed commit, then with the
     * ephemeral-key-signed reveal. Same callback for both — the
     * consumer typically wires this to electrs POST /tx.
     */
    broadcast(txHex: string): Observable<string>;
    /**
     * Optional hook fired when the wallet-signed commit hex is in hand,
     * BEFORE broadcast. Useful for consumers that want to swap in a
     * package broadcast or persist the signed bytes for retry.
     */
    onCommitSigned?(signedCommitHex: string): void;
    /**
     * Watch-only signers (psbt-export) bridge to user-mediated signing.
     * Browser-wallet signers ignore it.
     */
    promptForSignedPsbt?(unsigned: {
        base64: string;
        hex: string;
    }): Observable<string>;
}
interface InscribeAndBroadcastResult {
    commitTxId: string;
    revealTxId: string;
    commitAddress: string;
    /** Ephemeral bearer key — persist or forfeit reveal-side flexibility. */
    ephemeral: CreateInscribeTransactionsResult['ephemeral'];
    /** Final commit + reveal fees + vsizes (for UI display). */
    fees: CreateInscribeTransactionsResult['fees'];
}
declare function inscribeAndBroadcast(args: InscribeAndBroadcastArgs): Observable<InscribeAndBroadcastResult>;

/**
 * User-configured policy that every autonomous CAT-21 action must satisfy
 * before the SDK lets it proceed. Each agent / bot stores this struct
 * locally; the SDK is stateless and just evaluates a (policy, action) pair.
 *
 * All amounts are sats so there is no float arithmetic on the safety path.
 * The "daily" cap is enforced against `spentTodaySats` passed in via the
 * action context (callers are responsible for tracking their own running
 * total — the SDK does not persist state).
 */
interface AgentPolicy {
    enabled: boolean;
    /** Per-action sat ceiling. Hard cap; no autonomous tx may exceed this. */
    maxSpendPerActionSats: number;
    /** Daily aggregate cap. Caller resets at the boundary they prefer. */
    dailyCapSats: number;
    /** Fee-rate ceiling in sat/vB. Defends against fee runaway during congestion. */
    maxFeeRateSatPerVbyte: number;
    /** Minimum acceptable price when the agent might sell a cat we own. */
    floorPriceSatsPerCat: number;
    /**
     * Counterparty allowlist. Empty array = allow any counterparty.
     * Non-empty = strict allowlist (Bitcoin address match).
     */
    allowedCounterparties: string[];
    /**
     * Operation-kind allowlist. When set and non-empty, ONLY the listed
     * cat21 RPC methods are accepted; any other kind fails closed with
     * `operation-kind-not-allowed` from the structural gate.
     *
     * Use case: a wallet provisions an agent identity for a specific
     * job — "mint only" (`['cat21_mint']`) or "trade-only, no minting"
     * (`['cat21_create_offer', 'cat21_accept_offer']`).
     *
     * When unset or empty array → all four kinds accepted (default
     * permissive). The capability check fires BEFORE per-operation
     * field validation, so a disallowed-kind probe can't fingerprint
     * the allowed shape via field-level error reasons.
     */
    allowedOperations?: AgentActionKind[];
}
/**
 * The four CAT-21 RPC method names — matches the wallet's typed RPC
 * surface (`cat21_mint`, `cat21_transfer`, `cat21_create_offer`,
 * `cat21_accept_offer`) verbatim so the mapping between agent-policy
 * `kind` and wallet RPC method is the identity function. No
 * translation layer = no place for the mapping to drift.
 *
 * The literal names also document themselves: a reader of the SDK
 * sees `'cat21_accept_offer'` and knows exactly which wallet RPC
 * method the policy is gating, without having to chase an alias.
 */
type AgentActionKind = 'cat21_mint' | 'cat21_transfer' | 'cat21_create_offer' | 'cat21_accept_offer';
interface AgentActionContext {
    kind: AgentActionKind;
    /** Sats the agent commits on this action (mint fee+postage, or buy price). */
    spendSats: number;
    /** sat/vB the agent intends to pay. */
    feeRateSatPerVbyte: number;
    /**
     * Counterparty address.
     *   - `cat21_create_offer`: the buyer we'd accept BTC from (we are
     *     the seller; this is where the BTC payment lands).
     *   - `cat21_accept_offer`: the buyer whose PSBT we're signing.
     *   - `cat21_transfer`: the recipient of the cat.
     *   - `cat21_mint`: unused (no counterparty — we're paying the network).
     */
    counterpartyAddress?: string;
    /**
     * For `cat21_accept_offer`: the price we'd receive when the buyer's
     * PSBT confirms.
     * For `cat21_create_offer`: the listed asking price (what we'd
     * receive if the listing fills).
     * Both flows are gated against `floorPriceSatsPerCat` by the same
     * policy branch — set this on both, omit on `cat21_mint` and
     * `cat21_transfer` (which have no price semantic).
     */
    receivePriceSats?: number;
    /** Sats already spent today by the agent. Caller passes the rolling sum. */
    spentTodaySats: number;
}
type AgentPolicyDecision = {
    allowed: true;
} | {
    allowed: false;
    reason: AgentPolicyDenyReason;
    detail?: string;
};
type AgentPolicyDenyReason = 'agent-disabled' | 'spend-above-action-cap' | 'spend-above-daily-cap' | 'fee-rate-above-ceiling' | 'price-below-floor' | 'counterparty-not-allowed';

/**
 * Pure-functional policy gate for agent-mode autonomous CAT-21 actions.
 *
 * Every autonomous `cat21_*` action must pass through this gate BEFORE
 * the agent constructs a PSBT or asks the wallet to sign. A deny
 * decision short-circuits the action with a typed reason; the caller
 * surfaces the reason verbatim to the user (or logs it for the bot).
 *
 * Order of checks is cheapest first so we don't burn CPU on an action
 * that fails for a simple reason. The action-cap is usually more
 * restrictive than the daily-cap so it comes first.
 *
 * Counterparty check is substring/equality on Bitcoin addresses — no
 * BIP-32 re-derivation, no DNS resolution. The caller already knows the
 * exact address being paid / received and passes it through.
 *
 * Floor-price check fires on the two flows where the policy has price
 * agency:
 *   - `cat21_accept_offer`: a counterparty's inbound PSBT pays us less
 *     than our floor (REACTIVE — we either sign or don't).
 *   - `cat21_create_offer`: the bot autonomously proposes to list our
 *     cat below our floor (PROACTIVE — the bot picks the price). The
 *     undercut-prevention case the audit caught; arguably the more
 *     important of the two since publish-time is the moment the
 *     autonomous policy actually has agency.
 *
 * `cat21_mint` and `cat21_transfer` have no price semantic; spend caps
 * + fee-rate ceiling are sufficient there.
 */
declare function evaluateAgentPolicy(policy: AgentPolicy, action: AgentActionContext): AgentPolicyDecision;

export { AUTO_SCAN_MAX_VALUE_SAT, CAT21_LOCK_TIME, CAT21_OFFER_INPUT_SEQUENCE, CAT21_OFFER_POSTAGE_SATS, CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE, CAT21_POSTAGE_SATS, CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS, CAT21_TRANSFER_POSTAGE_SATS, CAT21_WALLET_INPUT_SEQUENCE, Cat21AcceptOfferOrchestrator, Cat21ApiService, Cat21CreateOfferOrchestrator, Cat21MintOrchestrator, Cat21Service, Cat21TransferOrchestrator, DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS, INSCRIBE_POSTAGE_SATS, KnownOrdinalWalletType, KnownOrdinalWallets, LAST_CONNECTED_WALLET, MAX_BUY_OFFER_PSBT_BYTES, Network, ORD_TAGS, SLIPSTREAM_BODY_TX_FIELD, SLIPSTREAM_DEFAULT_BASE_URL, SLIPSTREAM_SUBMIT_PATH, SMALL_UTXO_WARNING_THRESHOLD_SAT, STANDARD_TX_WEIGHT_LIMIT, UtxoContentScanner, WalletService, assertCat21LockTime, bitcoinNetwork, broadcastCat21, broadcastInscribePackage, bucketOf, buildCat21BuyOfferPsbt, buildCat21TransferPsbt, buildInputScript, buildInscribeCommitPsbt, buildInscribeRevealTx, buildInscriptionEnvelope, calculateRecommendedFundingSats, cat21Config, createInscribeTransactions, createTransaction, decideBroadcastChannel, deriveRevealPubkeyXonly, evaluateAgentPolicy, findAutoPickCandidate, getAddressFormat, getAddressNetwork, getDummyKeypair, getDummyLegacyTransaction, getMinimumUtxoSize, inscribeAndBroadcast, isAddressCompatibleWithNetwork, isScanComplete, isSegWit, leatherOrdinalsAddressType, leatherPaymentAddressType, listFundingUtxosThatCover, pickLargestFundingUtxoThatCovers, pickSmallestFundingUtxoThatCovers, prepareBuyOfferBuyerInput, prepareInscribeFundingInput, prepareMintInputForWallet, prepareTransferCatInput, prepareTransferFundingInput, resolveCat21InputSequence, runeNamesFromContent, simulateInscribeFees, storage, submitToSlipstream, toBitcoinNetworkType, toLeatherNetworkString, toScureNetwork, toXOnly, twoPassFeeSimulation, validateCat21BuyOfferPsbt };
export type { AcceptOfferState, AddressNetworkGroup, AgentActionContext, AgentActionKind, AgentPolicy, AgentPolicyDecision, AgentPolicyDenyReason, BuildCat21BuyOfferArgs, BuildCat21BuyOfferResult, BuildCat21TransferArgs, BuildCat21TransferResult, BuildInputScriptArgs, BuildInputScriptResult, BuildInscriptionEnvelopeArgs, BuyOfferTargetCat, Cat21, Cat21BroadcastChannel, Cat21BroadcastDecision, Cat21BroadcastInput, Cat21BroadcastOptions, Cat21BroadcastResult, Cat21Holding, Cat21OfferBuyerInput, Cat21OfferDestinations, Cat21OfferRejectionReason, Cat21OfferSellerInput, Cat21OfferValidation, Cat21OfferValidationFailure, Cat21OfferValidationResult, Cat21OrdOutputResponse, Cat21PaginatedResult, Cat21SdkConfig, Cat21SingleResult, Cat21TransferCatInput, Cat21TransferDestinations, Cat21TransferFundingInput, CatNumbersResult, CreateInscribeTransactionsArgs, CreateInscribeTransactionsResult, CreateOfferSimulation, CreateOfferSimulationOutcome, CreateOfferState, CreateTransactionResult, DummyKeypairResult, ErrorResponse, FundingUtxo, InscribeAndBroadcastArgs, InscribeAndBroadcastResult, InscribeCommitArgs, InscribeCommitResult, InscribeFundingInput, InscribePackageBroadcastInput, InscribePackageBroadcastOptions, InscribePackageBroadcastResult, InscribePackageEndpointResult, InscribeRevealArgs, InscribeRevealResult, KnownOrdinalWallet, LeatherAddress, LeatherAddressResponse, LeatherBtcAddress, LeatherPSBTBroadcastResponse, LeatherSignPsbtRequestParams, LeatherStxAddress, MempoolTx, MintState, OrdEnvelopeField, OrdOutputResponse, OrdTag, ParsedOffer, PendingMint, PickFundingUtxoArgs, PrepareBuyOfferBuyerInputArgs, PrepareInscribeFundingInputArgs, PrepareTransferInputArgs, RecommendedFees, SimulateInscribeFeesArgs, SimulateInscribeFeesResult, SimulateTransactionResult, SlipstreamSubmitResponse, StatusResult, StorageLike, SubmitToSlipstreamOptions, TransferSimulation, TransferSimulationOutcome, TransferState, TwoPassFeeSimulationArgs, TwoPassFeeSimulationResult, TxnOutput, TxnOutputStatus, UtxoContent, UtxoScanBucket, UtxoScanState, UtxoSimulation, ValidateCat21BuyOfferArgs, WalletConnector, WalletInfo, WindowLike, XverseAddressResponse };
