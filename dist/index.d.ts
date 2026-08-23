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
interface SignMessageArgs {
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
interface SignMessageResult {
    /**
     * Base64-encoded BIP-322 "simple" signature witness. Wallet-format-
     * dependent: some return raw 64/65-byte schnorr sigs, some wrap in
     * a serialized witness stack (`numItems || sigLen || sigBytes`).
     * `verifyListingSignature` accepts both shapes.
     */
    signature: string;
}
declare enum KnownOrdinalWalletType {
    xverse = "xverse",
    leather = "leather",
    unisat = "unisat",
    wizz = "wizz",
    okx = "okx",
    phantom = "phantom",
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
 * RBF-signalling sequence. Used on every input that comes from a
 * `cat21wallet` signer AND on ALL cat inputs for transfer + offer
 * flows regardless of wallet — see the scope note below.
 *
 * Our own accelerate code path is required to preserve `lockTime=21`
 * through any RBF replacement (cat21-wallet HARD RULE #1), so
 * signalling RBF is safe AND useful: users bump a stuck fee without
 * rebuilding the transaction.
 */
declare const CAT21_WALLET_INPUT_SEQUENCE = 4294967293;
/**
 * Non-RBF sequence. ONLY used on CAT-21 MINT inputs signed by a
 * third-party wallet (Xverse, Unisat, Leather, OKX, Wizz,
 * Phantom, Alby, …). Locks their accelerate UI out of touching a
 * mint tx — the 2024 Xverse incident defence: a third-party wallet's
 * fee-bump flow would build a replacement without `lockTime=21`,
 * burning the not-yet-confirmed mint.
 *
 * Transfers, offers, and any other post-mint cat-flow do NOT use
 * this value — the cat is already on chain, so the worst
 * third-party-RBF outcome is a missed bonus mint, not a cat loss.
 */
declare const CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE = 4294967294;
/**
 * MINT-ONLY sequence resolver — do NOT call from transfer / offer /
 * any other cat-flow builder. Every cat-flow builder except mint
 * uses `CAT21_WALLET_INPUT_SEQUENCE` (RBF-on) unconditionally.
 *
 * The mint case is special because the not-yet-confirmed mint tx
 * carries the `lockTime=21` protocol marker — an RBF replacement
 * built by a third-party wallet's accelerate UI would DROP the
 * marker (that wallet doesn't know about cats). Every other
 * cat-touching tx runs against a cat that's already on chain; a
 * marker-less RBF replacement there only loses a bonus mint. That's
 * "user's pity" territory (see workspace CLAUDE.md), NOT a fund
 * loss, so we don't degrade the RBF UX for third-party sellers /
 * transferers to prevent it.
 *
 * The SDK's CAT-21 RBF-policy HARD RULE is enforced at exactly ONE
 * place: this function. Renaming it away from the generic
 * `resolveCat21InputSequence` is deliberate — the old name was a
 * footgun; transfer + offer got wired to it and the RBF-off leak
 * only surfaced in the 2026-07-25 code review (finding #8).
 */
declare function resolveCat21MintInputSequence(walletType: KnownOrdinalWalletType): number;

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
 * Can this payment address be used to fund an inscribe commit?
 *
 * The inscribe pipeline pre-builds the reveal tx referencing the
 * commit tx's SIMULATION txid (the commit isn't signed yet at that
 * point). This assumes the txid is witness-independent — true for
 * segwit inputs (signature lands in the witness, which is NOT part
 * of the txid preimage). For legacy P2PKH inputs the signature lands
 * in `scriptSig`, which IS in the non-witness serialization, so the
 * real-signed commit has a DIFFERENT txid than the simulation and
 * the pre-built reveal points at a txid that never existed on chain.
 * The commit broadcasts fine, the reveal broadcast fails with
 * `bad-txns-inputs-missingorspent`, and the postage sits locked in
 * the commit output with no key to spend it (the ephemeral key that
 * would sign a fresh reveal against the real commit txid is gone
 * once the flow ends).
 *
 * Consumers use this to gate the inscribe UI: disable the button,
 * show a "switch to Native SegWit or Taproot" banner, refuse before
 * the user commits a fee. The inscribe pipeline itself also throws
 * on this address type as defense-in-depth.
 *
 * P2SH is treated as SUPPORTED — it's assumed to wrap SegWit
 * (P2SH-P2WPKH / Nested SegWit is the common case). The rare
 * non-SegWit P2SH scripts would trip a different failure inside
 * scure at signing time, not a silent postage loss.
 */
declare function isInscribeSupportedPaymentAddress(address: string): boolean;
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
 * True when `a` and `b` are the SAME Bitcoin address by scriptPubKey,
 * even if the two strings differ. Decodes both to scriptPubKey bytes
 * and byte-compares. This is the canonical address-equivalence check
 * that guards payout / recipient / allowlist addresses, so it lives in
 * ONE place. Defends against:
 *
 *   - BIP173 uppercase/lowercase: `BC1QW508…` and `bc1qw508…` are the
 *     same address (scure accepts both), so a config storing one form
 *     still matches the other.
 *   - Homoglyph swaps (Latin/Cyrillic look-alikes): decode to a
 *     different (or undecodable) script → unequal.
 *   - Mixed encodings: `bc1q…` (P2WPKH) vs `3…` (P2SH-wrapped) decode
 *     to different scripts → correctly unequal.
 *
 * Returns `false` on any decode failure of EITHER address (a config
 * typo / whitespace rejects the candidate without crashing the caller).
 *
 * `network` is the scure network OBJECT (mainnet / testnet / regtest,
 * all structurally `typeof btc.NETWORK`). Callers holding the SDK
 * `Network` enum convert via `toScureNetwork(...)` first.
 */
declare function addressesEquivalent(a: string, b: string, network: typeof btc.NETWORK): boolean;
/**
 * True when `candidate` is equivalent (per `addressesEquivalent`) to
 * any address in `allowlist`.
 */
declare function allowlistContainsAddress(candidate: string, allowlist: ReadonlyArray<string>, network: typeof btc.NETWORK): boolean;

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

/**
 * The canonical prepared-PSBT-input shape every CAT-21 Layer-1 builder
 * consumes (mint / transfer / offer / inscribe). scure needs different
 * fields per address type; this carries them all, optionally. The
 * per-domain input types (`Cat21MintFundingInput`,
 * `Cat21TransferCatInput` / `…FundingInput`, `Cat21OfferBuyerInput`,
 * `InscribeFundingInput`) are aliases of this one shape.
 */
interface Cat21PreparedInput {
    txid: string;
    vout: number;
    /** Sats locked in the UTXO (cat UTXOs are usually 546). */
    value: number;
    /** scriptPubKey bytes. */
    scriptPubKey: Uint8Array;
    /** For taproot inputs, the x-only internal public key (enables key-path signing). */
    tapInternalKey?: Uint8Array;
    /** For P2SH-wrapped SegWit inputs (Xverse Nested SegWit, Unisat-NestedSegWit). */
    redeemScript?: Uint8Array;
    /**
     * For legacy P2PKH inputs (Unisat-Legacy). Full previous-transaction
     * bytes — scure refuses to sign legacy inputs from witnessUtxo alone.
     */
    nonWitnessUtxo?: Uint8Array;
}
interface PrepareCat21InputArgs {
    utxo: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    isSimulation: boolean;
    network: Network;
}
/**
 * Layer-2 input adapter shared by the mint / transfer / offer / inscribe
 * pipelines: turn a raw funding UTXO (`TxnOutput`) plus the wallet's
 * payment details into the prepared PSBT-input shape the Layer-1
 * builders consume.
 *
 * Address-format-driven via `buildInputScript` — universal dispatch
 * across every wallet the SDK supports. The wallet identity is
 * irrelevant to script construction; only the payment address shape
 * matters. Handles taproot (`tapInternalKey`), P2SH-wrapped SegWit
 * (`redeemScript`), and legacy P2PKH (`nonWitnessUtxo`, since scure
 * refuses witnessUtxo on legacy inputs). Pure function. No I/O, no
 * Angular.
 */
declare function prepareCat21Input(args: PrepareCat21InputArgs): Cat21PreparedInput;
/**
 * Add a prepared cat21 input to `tx` at the given `sequence`, encoding
 * the per-address-type PSBT fields. Shared by the mint / transfer /
 * offer-buyer builders so the input wire-format dispatch lives in one
 * place.
 *
 *   - Legacy P2PKH (`nonWitnessUtxo` set): `nonWitnessUtxo` +
 *     SIGHASH_ALL + optional `redeemScript` (scure refuses witnessUtxo
 *     on legacy inputs).
 *   - SegWit: `witnessUtxo` + optional `redeemScript` (P2SH-wrap) +
 *     optional `tapInternalKey` (Taproot key-path).
 *
 * Taproot inputs OMIT `sighashType`. Per BIP-341 SIGHASH_DEFAULT
 * (absent) and SIGHASH_ALL commit to identical bytes for a key-path
 * spend — only the signature length differs (64 vs 65). Some wallet
 * signers default to DEFAULT for Taproot and a few (Alby's
 * bitcoinjs-lib signer) REJECT an explicit SIGHASH_ALL on Taproot
 * because it requires an `allowedSighashTypes` opt-in the wallet
 * doesn't expose. Omitting the field lets the signer pick its default;
 * the wire commitment is identical.
 */
declare function addCat21Input(tx: btc.Transaction, input: Cat21PreparedInput, sequence: number): void;

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
declare function isValidPersistedWalletInfo(v: unknown): v is WalletInfo;
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
    signMessage(input: SignMessageArgs): Observable<SignMessageResult>;
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
 * Branded Bitcoin address types — compile-time separation of the two
 * categories that keep getting confused in code review + at run time:
 *
 *   - `OrdinalsAddress` — the address a wallet's ordinals-key signs.
 *     Cats, inscriptions, runes, rare sats live here. Almost always
 *     a P2TR (taproot) address in modern wallets. Every on-chain
 *     "who owns this cat / inscription" lookup returns this type;
 *     ord's `/output/*` / `/cat/*` / `/inscription/*` all speak in
 *     this context.
 *   - `PaymentAddress` — the address a wallet's payment-key signs.
 *     BTC for fees and change lives here. Usually P2WPKH (bech32) or
 *     P2SH-P2WPKH; on single-address wallets (Unisat, xpub-only),
 *     structurally equal to `OrdinalsAddress`.
 *
 * The types share the underlying representation (`string`) so a
 * branded value flows freely into any `string` parameter — nothing
 * you already have breaks. The protection kicks in when a callee
 * types its parameter as one of the branded types: passing the
 * wrong brand fails to compile.
 *
 * Consumers that pass a bare `string` (URL params, textbox input,
 * on-chain lookup responses) must go through a constructor
 * (`toPaymentAddress` / `toOrdinalsAddress`). The constructor
 * validates the raw bytes AND forces the caller to name the type
 * explicitly — which is the friction that prevented the 2026-07-18
 * "auto-fill payment address from cat's on-chain owner" bug. See
 * the SDK CLAUDE.md HARD RULE "Never derive a payment address from
 * an on-chain lookup" for the full incident writeup.
 *
 * The typical trigger for those bugs is prose that talks about "the
 * seller's address" as if that were a single concept. The two are
 * different signing surfaces on the same wallet; the type system
 * refuses to conflate them.
 */
declare const OrdinalsBrand: unique symbol;
declare const PaymentBrand: unique symbol;
/**
 * A Bitcoin address that belongs to a wallet's ORDINALS-signing key.
 * Anything a cat, inscription, or rune lands on; the address ord
 * returns on ownership lookups.
 */
type OrdinalsAddress = string & {
    readonly [OrdinalsBrand]: true;
};
/**
 * A Bitcoin address that belongs to a wallet's PAYMENT-signing key.
 * Anything that receives ordinary BTC — offer payments, change
 * outputs, fee-paying UTXOs.
 */
type PaymentAddress = string & {
    readonly [PaymentBrand]: true;
};
/**
 * Cast a raw string into an `OrdinalsAddress`. Use at the boundary
 * where the wallet or ord API returns an owner address — this
 * documents "we treated this string as ordinals-context, and the
 * downstream type system will enforce it stays there".
 */
declare function toOrdinalsAddress(s: string): OrdinalsAddress;
/**
 * Cast a raw string into a `PaymentAddress`. Use at the boundary
 * where the wallet returns its payment address, OR where the seller's
 * payment address arrives from a trusted-to-be-payment source (the
 * URL's `payTo=` param — see `parseAskQueryParams` — or the seller's
 * connected wallet at sell-modal time).
 *
 * **Never** call this on a value that came from an on-chain owner
 * lookup — that's the ordinals address in ordinal-theory-tracked
 * contexts. The compiler can't stop you (both types are `string`
 * subtypes), but the SDK HARD RULE "Never derive a payment address
 * from an on-chain lookup" spells out why the audit will reject it.
 */
declare function toPaymentAddress(s: string): PaymentAddress;
/**
 * Escape hatch for the rare code that legitimately does not care
 * about the signing context — e.g. rendering an address in a
 * text-only display, hashing for equality, logging. Prefer the
 * branded types wherever the address will be USED (as an input to a
 * PSBT builder, a validator, a signer). Only reach for this when
 * you need a raw string for a truly context-free operation.
 */
declare function eitherAsString(addr: OrdinalsAddress | PaymentAddress | string): string;

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
type Cat21MintFundingInput = Cat21PreparedInput;

/**
 * Layer-2 input adapter for the CAT-21 mint pipeline. Thin,
 * positional-args wrapper over the shared `prepareCat21Input`; the
 * mint / transfer / offer / inscribe adapters all delegate to that one
 * body so the wire-format logic (taproot / P2SH / legacy dispatch)
 * lives in a single place.
 */
declare function prepareMintInputForWallet(paymentOutput: TxnOutput, paymentPublicKey: Uint8Array, paymentAddress: string, isSimulation: boolean, network: Network): Cat21MintFundingInput;

/**
 * Ordinal-theory sat rarity math. Pure functions, no I/O — every
 * classification is derived from the sat number alone.
 *
 * Categories (highest rarity wins when multiple apply):
 *   - `mythic`     — sat 0 (the very first sat of Bitcoin, block 0).
 *   - `legendary`  — first sat of a cycle (every 6 halvings = 1_260_000 blocks).
 *   - `epic`       — first sat of a halving block (every 210_000 blocks).
 *   - `rare`       — first sat of a difficulty adjustment block (every 2016 blocks).
 *   - `uncommon`   — first sat of any other block.
 *   - `common`     — every non-first sat.
 *
 * Halving epochs shrink block subsidy by half every 210_000 blocks:
 *   e=0 (blocks 0..209_999):        50 BTC =           5_000_000_000 sat
 *   e=1 (blocks 210k..419_999):     25 BTC =           2_500_000_000 sat
 *   e=2 (blocks 420k..629_999):     12.5 BTC =         1_250_000_000 sat
 *   e=3 (blocks 630k..839_999):     6.25 BTC =           625_000_000 sat
 *   ...
 *   e=32 approximately mines the last sat; subsidy becomes 0 sat at e=33.
 *
 * We use bigint throughout because the total sat supply (~21e14 sats)
 * exceeds `Number.MAX_SAFE_INTEGER` (~9e15 fits, but midway math needs
 * safety) and range-endpoint math is easier without precision loss.
 */
type SatRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
/** Rarity of the FIRST sat of a given block. Non-first sats are always `common`. */
declare function rarityOfBlockFirstSat(block: number): SatRarity;
/**
 * Given a sat number, return the block it was mined in AND the first
 * sat of that block. If `sat === firstSatOfBlock`, the sat is the
 * uncommon (or higher) block-first-sat; otherwise it's common.
 */
declare function locateSat(sat: bigint): {
    block: number;
    firstSatOfBlock: bigint;
    subsidy: bigint;
};
/** Rarity of an individual sat. */
declare function rarityOfSat(sat: bigint): SatRarity;
/**
 * Find the highest-rarity sat inside a half-open range `[start, end)`.
 *
 * O(1) in the range width: given the block containing `start` and the
 * block containing `end-1`, we ask "does this block interval contain
 * any multiple of X" for each rarity threshold (cycle, halving,
 * difficulty adjustment). The rarest positive answer wins. No
 * block-by-block iteration.
 *
 * That matters because `sat_ranges` returned by ord can span millions
 * of blocks for wide UTXO ranges; a walker would be prohibitive.
 */
declare function findRareSatInRange(start: bigint, end: bigint): {
    sat: bigint;
    block: number;
    rarity: SatRarity;
} | null;
declare function findRareSatInRanges(ranges: ReadonlyArray<readonly [bigint, bigint]>): {
    sat: bigint;
    block: number;
    rarity: SatRarity;
} | null;

/**
 * Asset-detection types for the mint flow's UTXO scanner. We query
 * BOTH our ord instance (`ord.ordpool.space`, returns regular
 * inscriptions + runes) AND our cat21-ord (`ord.cat21.space`, returns
 * CAT-21 cats) per outpoint, merging the answers into one
 * `UtxoContent`. Rare-sat classification is derived client-side from
 * ord's `sat_ranges` via `sat-rarity.helper.ts`.
 *
 * The detection is content-safety, not fee-math: an inscription at the
 * dust limit (546 sat) reads as "tiny UTXO" to the picker but carries
 * arbitrary off-chain value. On single-address wallets, spending such
 * a UTXO as a mint input sends the asset to the miner as fee. The same
 * risk applies to a UTXO carrying a rare sat.
 */

/**
 * Raw `/output/{outpoint}` shape returned by ord with the JSON API
 * enabled. The subset we read here.
 *
 * `sat_ranges` — array of `[start, end)` tuples of sat numbers this
 *   output holds. Can be enormous for wide / mixed UTXOs (thousands
 *   of tuples, MBs of payload). The scanner gates rare-sat detection
 *   behind a small-UTXO threshold + range-count cap so the naive
 *   "fetch everything, scan all ranges" cost doesn't dominate.
 */
interface OrdOutputResponse {
    inscriptions?: string[];
    runes?: {
        [runeName: string]: unknown;
    } | null;
    sat_ranges?: ReadonlyArray<readonly [number, number]>;
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
    /**
     * Sat the cats at this outpoint sit on, or `null` when the outpoint holds
     * no cats or ord returned no sat ranges.
     *
     * CAT-21 pins a cat to offset 0 of its output (FIFO), so every cat here
     * shares the first sat of the first range. That makes the sat derivable from
     * the scan alone, with no per-cat lookup, and it is what a UI should link to:
     * a sat page shows every cat riding that sat and where it sits now, whereas
     * the mint transaction shows only where a cat started and misleads once it
     * has moved.
     */
    catSat: number | null;
    /**
     * Rarest sat inside the UTXO's `sat_ranges`, when the scanner ran
     * the rare-sat check (small-UTXO gate — see `RARE_SAT_SCAN_MAX_VALUE_SAT`).
     * `null` when no rare sat was found OR when the check was skipped
     * for cost reasons (large UTXO, pathological range count).
     */
    rareSat: {
        sat: string;
        block: number;
        rarity: SatRarity;
    } | null;
}
/**
 * Skip rare-sat detection when ord returns more than this many
 * `sat_ranges` tuples on a UTXO. Mixed / heavily-recycled UTXOs can
 * carry thousands — parsing them all would dominate the scanner's
 * per-UTXO cost budget. The bandwidth cost of receiving those tuples
 * is already sunk (ord doesn't let us opt out of `sat_ranges`), but
 * we can at least skip the parse.
 *
 * Below the cap: rarity math is O(1) per tuple, so bounded work.
 * Above the cap: `rareSat` on `UtxoContent` stays null; the picker
 * treats the UTXO as "rarity unchecked" rather than "clean".
 */
declare const RARE_SAT_MAX_RANGES = 500;
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
 * the offer builder does NOT coin-select. Same prepared-input shape as
 * every other cat-touching flow ({@link Cat21PreparedInput}).
 */
type Cat21OfferBuyerInput = Cat21PreparedInput;
/** Output destinations of an ord-style offer. */
interface Cat21OfferDestinations {
    /** Where the cat lands. The first sat of this output ends up holding the cat. */
    buyerReceiveAddress: string;
    /** Where the buyer's BTC payment goes. */
    sellerPaymentAddress: string;
    /** Where buyer change goes (when above dust). */
    buyerChangeAddress: string;
}
/**
 * Reasons the buy-offer validator may reject an inbound PSBT.
 *
 * Split by audience:
 *   - Seller-side: caller cares that the deal they'd sign matches the
 *     deal they think they're signing (input 0, seller payment, sighash,
 *     etc.). These fire whether or not any buyer-side expectation is
 *     supplied.
 *   - Marketplace / buyer-side: `cat-output-wrong-address`,
 *     `change-output-wrong-address`, `wrong-price-exact` only fire when
 *     the corresponding `expected*` arg is supplied. A bare seller-side
 *     caller (no marketplace context) never sees them.
 */
type Cat21OfferRejectionReason = 'malformed-offer-psbt' | 'missing-seller-input' | 'wrong-postage' | 'wrong-price' | 'wrong-price-exact' | 'wrong-seller-input-value' | 'sighash-not-all' | 'sighash-flag-byte-not-all' | 'buyer-input-unsigned' | 'missing-seller-payment-output' | 'payment-output-wrong-address' | 'cat-output-not-spendable' | 'cat-output-wrong-address' | 'change-output-wrong-address';
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
 * Arguments for `buildCat21BuyOfferPsbt`.
 *
 * The caller is responsible for coin selection (the SDK exposes coin-selection
 * helpers in `cat21-mint`; reuse them). This function only structures the PSBT
 * and validates the SIGHASH invariant; it does not pick UTXOs, fetch them, or
 * compute fees.
 */
interface BuildCat21BuyOfferArgs {
    /**
     * The BUYER's wallet type. Currently unused for sequence-picking —
     * offers ship with `sequence = 0xfffffffd` (RBF on) for every wallet.
     * The mint-only RBF-off gate (`resolveCat21MintInputSequence`) is NOT
     * applied here: the cat is already on chain, so a third-party
     * accelerate UI dropping `lockTime=21` on an RBF replacement only
     * loses the bonus mint, not the cat itself. Kept in the type so
     * consumers keep sending it — future flows may need it.
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
    expectedSellerPaymentAddress: PaymentAddress;
    /**
     * Network used to decode Output 1's `scriptPubKey` back to an address.
     * Defaults to mainnet. Callers signing on testnet/regtest must pass it.
     */
    network?: Network;
    /**
     * Optional. Marketplace-side check: when supplied, Output 0's script
     * is decoded and compared. Rejects with `cat-output-wrong-address` on
     * mismatch. A bare seller-side caller (no marketplace context) can
     * omit this; a marketplace indexer verifying "buyer signed for the
     * cat to go where their DTO claims" should always pass it.
     */
    expectedBuyerReceiveAddress?: OrdinalsAddress;
    /**
     * Optional. Marketplace-side check: when supplied AND Output 2
     * exists, Output 2's script is decoded and compared. Rejects with
     * `change-output-wrong-address` on mismatch. A tx with no Output 2
     * (buyer had no change) passes even when this arg is set.
     */
    expectedBuyerChangeAddress?: PaymentAddress;
    /**
     * Optional. Marketplace-side check: when supplied, tightens the
     * existing floor-based `pricePaidSats >= floorPriceSats` gate to an
     * EXACT equality (`pricePaidSats === expectedExactPrice`). Rejects
     * with `wrong-price-exact` on mismatch. Use when the buyer's DTO
     * declared a specific price and any deviation is signature drift.
     */
    expectedExactPrice?: number;
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
 *   4. Output 0 (cat) postage ≥ configured minimum, script decodable.
 *   5. Output 1 (seller payment) ≥ floor price.
 *   6. When `expectedSellerPaymentAddress` is supplied, Output 1's
 *      script is decoded and compared. Strongly recommended whenever
 *      a human eventually signs — the validator is the single source
 *      of truth and can't delegate to a UI layer that may or may
 *      not exist.
 *
 * Optional marketplace-side gates (only fire when the corresponding
 * `expected*` arg is supplied):
 *
 *   7. `expectedBuyerReceiveAddress` — Output 0's decoded address must
 *      match. Rejects `cat-output-wrong-address` on mismatch. Catches
 *      "buyer signed for the cat to go somewhere other than the
 *      address their marketplace DTO claims".
 *   8. `expectedBuyerChangeAddress` — Output 2's decoded address, when
 *      Output 2 exists, must match. Rejects `change-output-wrong-address`.
 *      Silent (no failure) when the tx has no Output 2.
 *   9. `expectedExactPrice` — tightens the floor gate to exact equality.
 *      Rejects `wrong-price-exact` on any deviation. Use when the DTO
 *      declared a specific price and drift means signature tampering.
 */
declare function validateCat21BuyOfferPsbt(args: ValidateCat21BuyOfferArgs): Cat21OfferValidation;

/**
 * Layer-2 input adapter for the BUYER side of the CAT-21 buy-offer flow.
 *
 * The buyer-initiated offer PSBT has the seller's cat UTXO at input 0
 * (unsigned, referenced out-of-band — NOT prepared here) and the
 * buyer's funding UTXOs at inputs 1..N (prepared here). Thin wrapper
 * over the shared `prepareCat21Input`.
 */
type PrepareBuyOfferBuyerInputArgs = PrepareCat21InputArgs;
declare function prepareBuyOfferBuyerInput(args: PrepareBuyOfferBuyerInputArgs): Cat21OfferBuyerInput;

/**
 * Bare cat UTXO outpoint — `{ txid, vout }` — the minimum a caller
 * needs to reference a specific cat on chain. Enriched siblings live
 * alongside their orchestrators and extend this shape:
 *
 *   - `Cat21Holding` (transfer): `CatOutpoint & { catNumber; value }`
 *   - `BuyOfferTargetCat` (offer-create): `CatOutpoint & { catNumber; value; scriptPubKey }`
 *   - `ParsedOffer.catUtxo` (offer-accept): re-uses `CatOutpoint`
 *
 * The URL-permalink layer (`permalink.helper.ts`) uses only the
 * bare shape — cat number + value are consumer-side enrichments.
 */
interface CatOutpoint {
    /** Lowercase 64-hex txid. */
    txid: string;
    /** Zero-based output index. */
    vout: number;
}

/**
 * What the buyer needs to know about the cat they want to bid on.
 * Caller (typically a frontend) fetches this from ord: cat number →
 * inscription → current UTXO at the seller's address.
 *
 * The PSBT pre-populates input 0's `witnessUtxo` from these bytes so
 * the seller can sign offline without a round-trip — that's the
 * "buyer-initiated, sniping-proof" property of ord-style offers.
 */
interface BuyOfferTargetCat extends CatOutpoint {
    catNumber: number;
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
    readonly sellerPaymentAddress: _angular_core.WritableSignal<PaymentAddress>;
    /** Sats the buyer offers (this is the "ask" the seller's eventual payout output carries — `priceSats + CAT21_POSTAGE_SATS`). */
    readonly priceSats: _angular_core.WritableSignal<number>;
    /** Where the cat lands after the seller signs + broadcasts. Default = connected wallet's ordinals address. */
    readonly buyerReceiveAddress: _angular_core.WritableSignal<string>;
    readonly feeRate: _angular_core.WritableSignal<number>;
    /**
     * User's explicit funding-UTXO pick from the buyer-side picker.
     * When null the orchestrator auto-picks the largest covering UTXO.
     * Set from the UI so the buyer can reject an asset-carrying UTXO
     * (inscription / rune / cat / rare sat) the auto-picker would
     * happily spend.
     */
    readonly selectedFundingUtxo: _angular_core.WritableSignal<TxnOutput>;
    private lastWalletAddress;
    private readonly priceSatsSubject;
    private readonly feeRateSubject;
    private readonly selectedFundingUtxoSubject;
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
    /**
     * Set the seller's PAYMENT address (where sale proceeds land). The
     * branded `PaymentAddress` type makes the "is this really a payment
     * address, not an ordinals one?" question un-skippable at every
     * callsite — either the value came from `parseBuyOfferQueryParams`
     * (which brands the URL `payTo=` param at ingress) or the caller
     * used `toPaymentAddress()` on a raw string. See SDK HARD RULE
     * "Never derive a payment address from an on-chain lookup".
     */
    setSellerPaymentAddress(address: PaymentAddress | null): void;
    setPriceSats(price: number): void;
    setBuyerReceiveAddress(address: string | null): void;
    setFeeRate(rate: number): void;
    /**
     * Push the buyer's funding-UTXO pick (or null to auto-pick). Called
     * from the picker UI whenever the buyer clicks a row in the
     * scanner-annotated funding list.
     */
    setSelectedFundingUtxo(utxo: TxnOutput | null): void;
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
    /** Cat being sold — sat 0 of this UTXO is the cat sat. */
    catUtxo: CatOutpoint;
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
     * No default. Human UI consumers that show the price in a summary
     * panel before signing (where the human IS the floor check) should
     * call `disableFloorGate()` at construction; headless / bot
     * consumers must set it programmatically via `setFloorPriceSats(n)`.
     */
    readonly floorPriceSats: _angular_core.WritableSignal<number>;
    /**
     * The cat the seller is selling (txid + vout). When set, validation
     * checks input 0 against this UTXO and rejects offers for the wrong
     * cat. UI typically derives this from the seller's selected cat-to-sell.
     */
    readonly expectedCatUtxo: _angular_core.WritableSignal<CatOutpoint>;
    /**
     * The address the seller wants the payment to land at. When set,
     * validation rejects offers whose Output 1 (seller payment) doesn't
     * decode to this exact address. Strongly recommended; matches
     * `validateCat21BuyOfferPsbt`'s `expectedSellerPaymentAddress` arg.
     */
    readonly expectedSellerPaymentAddress: _angular_core.WritableSignal<PaymentAddress>;
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
     * Human-UI opt-out for the floor safety-net.
     *
     * Sets floor to 0 AND keeps it there across resets — the seller
     * sees `pricePaidSats` in the validated summary before clicking
     * sign; the human is the check. Under the hood, this flips
     * `resetFormFields()` so `floorPriceSats` no longer wipes back to
     * `null` on wallet-swap / reset.
     *
     * Call once at construction / ngOnInit. `setFloorPriceSats(n)`
     * still works after — the seller can raise the floor to enable the
     * auto-reject-lowballs behaviour without touching this flag.
     *
     * Bot / headless consumers should NOT call this — they must set a
     * floor explicitly per-run so a forgotten value doesn't silently
     * pass a 1-sat offer. See audit finding H2 for the rationale.
     */
    disableFloorGate(): void;
    private humanUiOptOut;
    /**
     * MAX_PASTED_OFFER_BYTES exposed for the UI's pre-paste textarea
     * `maxlength` attribute. Mirrors the static class field so consumers
     * don't need to reach for the constructor.
     */
    readonly maxPastedOfferBytes: number;
    setExpectedCatUtxo(utxo: CatOutpoint | null): void;
    /**
     * Set the address the seller expects the payment output to land at.
     * Symmetric with `Cat21CreateOfferOrchestrator.setSellerPaymentAddress`
     * — branded for the same reason (SDK HARD RULE "Never derive a
     * payment address from an on-chain lookup"). Value must be
     * constructed via `toPaymentAddress()` or come pre-branded from the
     * URL parser / wallet fixture.
     */
    setExpectedSellerPaymentAddress(address: PaymentAddress | null): void;
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
 * FIFO, it travels to the first sat of output 0. Same prepared-input
 * shape as every other cat-touching flow ({@link Cat21PreparedInput}).
 */
type Cat21TransferCatInput = Cat21PreparedInput;
/**
 * Wallet-provided funding UTXOs that pay the miner fee. Coin selection is
 * the caller's responsibility — the builder does NOT select. The caller
 * may also pass zero funding inputs if the cat UTXO itself has surplus
 * value above postage + fee.
 */
type Cat21TransferFundingInput = Cat21PreparedInput;
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
 * Layer-2 input adapter for the CAT-21 transfer pipeline. Two semantic
 * entry points (the cat UTXO at input 0, the funding UTXOs at 1..N)
 * that both delegate to the shared `prepareCat21Input` — same prepared
 * shape, distinct names for reader intent.
 */
type PrepareTransferInputArgs = PrepareCat21InputArgs;
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
interface Cat21Holding extends CatOutpoint {
    catNumber: number;
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
    /**
     * User's explicit funding-UTXO pick from the picker. When null the
     * orchestrator auto-picks the largest covering UTXO (backwards-
     * compatible with the pre-picker behaviour). Set this from the UI's
     * scanner-annotated row selection so the user can reject an
     * asset-carrying UTXO the auto-picker would happily spend.
     */
    readonly selectedFundingUtxo: _angular_core.WritableSignal<TxnOutput>;
    private lastWalletAddress;
    private readonly catUtxoSubject;
    private readonly feeRateSubject;
    private readonly selectedFundingUtxoSubject;
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
     * Push the user's funding-UTXO pick (or null to fall back to
     * auto-pick). The picker UI calls this every time the seller clicks
     * a row in the scanner-annotated funding list.
     */
    setSelectedFundingUtxo(utxo: TxnOutput | null): void;
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
    /**
     * Slipstream bearer token. Slipstream authorises the broadcast with
     * `Authorization: Bearer <token>` (see `slipstream.helper.ts`); a
     * slipstream submit without it is auth-rejected. Required whenever a
     * broadcast actually routes to the slipstream channel.
     */
    slipstreamBearerToken?: string;
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
 * Permalink helpers for the three cat21-flow surfaces that ship a URL:
 *
 *   - **Ask permalink** — a seller publishes "I want to sell cat #N for X sats"
 *     as `/cat/N?ask=X`. Rendered by the cat detail page; anyone can view.
 *   - **Buy permalink** — a buyer clicks an ask link and lands on the
 *     make-offer surface prefilled with `catNumber` + `askPrice`. The
 *     `fromAsk` flag surfaces a "responding to an ask" banner so the
 *     buyer knows the price came from the seller, not their own guess.
 *   - **Accept-offer permalink** — after the buyer signs the offer PSBT
 *     they hand the seller a one-click link:
 *     `/dashboard/trade/accept?offer=<base64>&catTxid=<txid>&catVout=<n>`.
 *     Seller opens it, floor is auto-set to 0 (they consented by
 *     clicking the link), signs, cat moves on-chain.
 *
 * The SDK owns the QUERY shape (param names + encoding), consumers own
 * the URL PATH. Two consumers today — cat21.space (Path 1 via
 * cat21-indexer/frontend) and cat21-wallet manual/agent UIs (Path 2/3)
 * — share the same query names so a permalink minted by one is
 * consumable by the other.
 *
 * See workspace HARD RULE "Offers can be shared in the wild" in
 * `/Work/ordpool/CLAUDE.md` and its SDK companion. Distribution is
 * *not* the security boundary; the sniping-proof PSBT structure is.
 *
 * Pure functions. No Angular, no I/O.
 */

/** Query param keys — single source of truth. */
declare const CAT21_QUERY_KEYS: {
    /** `/cat/N?ask=<sats>` — seller advertises a price. */
    readonly ask: "ask";
    /**
     * `?payTo=<address>` — seller's PAYMENT address (from the seller's
     * own wallet). Carried in ask + buy-offer permalinks so the buyer
     * NEVER has to derive it from an on-chain owner lookup — the on-
     * chain owner is the seller's ORDINALS address (that's where cats
     * live). See the HARD RULE "Never derive a payment address from an
     * on-chain lookup" in the SDK CLAUDE.md.
     */
    readonly payTo: "payTo";
    /** `?catNumber=<n>` — pre-fill for make-offer or transfer. */
    readonly catNumber: "catNumber";
    /** `?askPrice=<sats>` — buyer-side landing knows what the seller asked. */
    readonly askPrice: "askPrice";
    /** `?fromAsk=1` — buyer-side banner "responding to an ask". */
    readonly fromAsk: "fromAsk";
    /** `?offer=<base64>` — the buyer-signed PSBT bytes to hand the seller. */
    readonly offer: "offer";
    /** `?catTxid=<64-hex>` — one half of the cat outpoint (matches offer input 0). */
    readonly catTxid: "catTxid";
    /** `?catVout=<uint>` — other half of the cat outpoint. */
    readonly catVout: "catVout";
};
interface AskQueryArgs {
    /** Price the seller is asking, in sats. Must be a positive integer. */
    askSats: number;
    /**
     * Seller's PAYMENT address — the address the buyer's PSBT should
     * route the payment output to. Optional in the type so legacy /
     * "make-me-an-offer" ask links still parse, but ALWAYS include it
     * when the seller's wallet is connected (the sell-modal on
     * cat21.space does this). Without it, the buyer's make-offer page
     * has no way to know where to send the sats without asking out-of-
     * band — the deep-link's whole point collapses.
     *
     * Do not populate from an on-chain owner lookup — that returns the
     * seller's ORDINALS address, which is the wrong one. See the HARD
     * RULE "Never derive a payment address from an on-chain lookup"
     * in the SDK CLAUDE.md.
     */
    sellerPaymentAddress?: string;
    /**
     * The cat UTXO outpoint at the moment the seller minted the link.
     * Pins the seller's INTENT to a specific cat UTXO: when a viewer
     * later loads the link, the consumer compares this against the
     * current on-chain outpoint (via cat21-indexer / ord). Mismatch
     * means the cat has moved since the link was created — the
     * original sell intent is void (someone else already bought /
     * transferred it) and any Buy action on the loaded page must
     * refuse to build a PSBT.
     *
     * Optional in the type so legacy "make me an offer" ask links
     * (no bound intent, no stale check) still parse; strongly
     * recommended when the seller's wallet is connected at
     * sell-modal-open time.
     */
    catOutpoint?: CatOutpoint;
}
interface ParsedAskQuery {
    askSats: number | null;
    /**
     * Branded because the `payTo=` URL param IS the seller's payment
     * address by construction — the seller's own wallet emitted it at
     * sell-modal time. The parser has enough context to hand it back
     * pre-branded so consumers don't have to re-cast at every callsite.
     */
    sellerPaymentAddress: PaymentAddress | null;
    /**
     * Cat UTXO the seller's intent was pinned to. Consumer compares
     * against the current on-chain outpoint to detect stale links
     * (cat has moved since link creation → offer void). See
     * `AskQueryArgs.catOutpoint` for the semantics.
     */
    catOutpoint: CatOutpoint | null;
}
declare function buildAskQueryParams(args: AskQueryArgs): Record<string, string>;
/**
 * Parse an ask-query. Returns `askSats` and `sellerPaymentAddress`
 * as separate nullables — a link with only `ask=` (legacy) parses
 * with `sellerPaymentAddress: null`; a link missing / malformed
 * `ask=` parses with `askSats: null`. Tampered addresses (garbage,
 * wrong HRP) come back as null; consumer's own address validator
 * still runs before signing.
 */
declare function parseAskQueryParams(query: URLSearchParams | Record<string, string | null>): ParsedAskQuery;
interface BuyOfferQueryArgs {
    /** Cat the buyer wants to bid on. */
    catNumber: number;
    /** Ask price from the seller's link, in sats. Optional — a plain
     *  "make me an offer" link is fine too. */
    askSats?: number;
    /**
     * Seller's PAYMENT address forwarded from the ask permalink. See
     * `AskQueryArgs.sellerPaymentAddress` for the why.
     */
    sellerPaymentAddress?: string;
    /**
     * Cat UTXO outpoint forwarded from the ask permalink. Pins the
     * seller's intent to a specific UTXO — the make-offer page
     * compares against the on-chain lookup and refuses to build a
     * PSBT if the cat has moved. See `AskQueryArgs.catOutpoint`.
     */
    catOutpoint?: CatOutpoint;
}
interface ParsedBuyOfferQuery {
    catNumber: number | null;
    askSats: number | null;
    fromAsk: boolean;
    /** Branded — see `ParsedAskQuery.sellerPaymentAddress`. */
    sellerPaymentAddress: PaymentAddress | null;
    /** Cat UTXO the seller pinned the offer to; null if not supplied.
     *  See `AskQueryArgs.catOutpoint` for the staleness semantics. */
    catOutpoint: CatOutpoint | null;
}
declare function buildBuyOfferQueryParams(args: BuyOfferQueryArgs): Record<string, string>;
declare function parseBuyOfferQueryParams(query: URLSearchParams | Record<string, string | null>): ParsedBuyOfferQuery;
interface AcceptOfferQueryArgs {
    /** Buyer-signed PSBT bytes, already base64-encoded. */
    offerBase64: string;
    /**
     * Cat outpoint the offer targets (matches offer input 0). Optional
     * — without it the accept page falls back to the seller's cat-picker.
     * Include it whenever the buyer knows the outpoint (typical for the
     * make-offer success flow) so the seller gets a true one-click accept.
     */
    catOutpoint?: CatOutpoint;
}
declare function buildAcceptOfferQueryParams(args: AcceptOfferQueryArgs): Record<string, string>;
declare function parseAcceptOfferQueryParams(query: URLSearchParams | Record<string, string | null>): {
    offerBase64: string | null;
    catOutpoint: CatOutpoint | null;
    bundleComplete: boolean;
};
interface TransferQueryArgs {
    /** Cat the sender is transferring. */
    catNumber: number;
    /** Cat outpoint. Optional — the transfer page falls back to picker if omitted. */
    catOutpoint?: CatOutpoint;
}
declare function buildTransferQueryParams(args: TransferQueryArgs): Record<string, string>;
declare function parseTransferQueryParams(query: URLSearchParams | Record<string, string | null>): {
    catNumber: number | null;
    catOutpoint: CatOutpoint | null;
};

/**
 * Upper bound on `askSats`. 21 million BTC = 2.1 × 10^15 sats — the
 * total supply ceiling. Any value above this is nonsense (a listing
 * can't cost more than every bitcoin that will ever exist). Both the
 * SDK message builder and the backend DTO enforce this so garbage
 * or attention-grab values never land in the orderbook DB.
 */
declare const MAX_ASK_SATS: number;
/**
 * A CAT-21 sell listing — the seller's advertised intent to sell a
 * specific cat UTXO at a specific price. Sits between the private
 * "share-a-URL" flow (workspace HARD RULE "Offers can be shared in
 * the wild") and the on-chain buy-offer PSBT flow — a listing is a
 * public advertisement, not a signed transaction.
 *
 * Every field is required so anyone (frontend, backend, mirror,
 * third-party crawler) can reconstruct the canonical signed message
 * from the row alone and re-verify the BIP-322 signature. No trust
 * in cat21-indexer.
 */
interface Cat21Listing {
    /**
     * Headline cat number for the listing — the lowest-numbered cat on
     * the UTXO. Presentational only (drives sort order and the "Cat #N"
     * display); the load-bearing identifier for what's being sold is
     * `cats` below. Every cat in `cats` is included in the sale because
     * a PSBT spends the whole UTXO, not individual sats.
     */
    catNumber: number;
    /**
     * Every cat currently sitting on the UTXO the listing pins
     * (`catTxid:catVout`). Ord's `/output/<outpoint>` endpoint returns
     * an array — a UTXO CAN carry multiple cats (typical: consolidation
     * of previously-minted cat UTXOs into one output ≥ N × 546 sats).
     * The seller cryptographically commits to this exact set, sorted
     * ascending, so the buyer sees "you're buying this whole bundle"
     * before signing. If a cat gets bundled onto the UTXO between sign
     * and accept, the bundle drifts and the listing is stale (same
     * eviction class as an outpoint drift).
     */
    cats: number[];
    /**
     * Bitcoin network the seller signed against. Load-bearing for
     * anti-replay: without this field, an attacker with a legit
     * testnet listing could replay the raw bytes to mainnet (or vice
     * versa) — cat numbering is shared across networks, and the
     * SDK's `verifyListingSignature` decodes both `bc1p` and `tb1p`
     * addresses. The seller's message COMMITS to the network, so
     * cross-network replays produce a signature that doesn't verify
     * against the destination network's address expectations.
     */
    network: Network;
    /** Price the seller is asking, in sats. Positive integer. Capped at MAX_ASK_SATS (21 M BTC). */
    askSats: number;
    /**
     * Where the seller's sale proceeds should land. Branded — same
     * "never derived from an on-chain lookup" guardrail the create-
     * offer orchestrator carries; see the SDK HARD RULE.
     */
    payTo: PaymentAddress;
    /** Cat UTXO the listing is pinned to (intent-lock). Lowercase hex. */
    catTxid: string;
    /** vout of the cat UTXO. */
    catVout: number;
    /**
     * The seller's ordinals address at signing time. This IS the
     * address whose ownership of the cat UTXO the BIP-322 signature
     * proves — the verifier decodes the P2TR script from here to
     * check the schnorr signature. Branded for the same reason as
     * `payTo`: address category is load-bearing.
     */
    ordinalsAddress: OrdinalsAddress;
    /**
     * Unix seconds at signing time. Anti-replay hint — the backend
     * MAY reject listings whose `signedAt` is older than a window
     * (e.g. > 24h in the past) or too far in the future. Also lets
     * the pruner sort by age for eviction ties.
     */
    signedAt: number;
    /**
     * Base64-encoded BIP-322 "simple" signature witness. For P2TR
     * ordinals addresses (the only kind cats live on today) this is
     * the serialized witness stack containing a single 64- or 65-byte
     * schnorr signature. Wallet-generated: Xverse's `signMessage`,
     * Leather's `signMessage`, cat21-wallet's `signMessage`, etc.
     */
    signature: string;
}

/**
 * Canonical listing-message format version. Bump when the field set,
 * order, or separator changes so old signatures don't accidentally
 * verify against a new-shape message (or vice versa).
 *
 * v3 (2026-07-22): the load-bearing identifier for a listing is the
 * cat UTXO (`catTxid:catVout`) plus the FULL set of cats that ride
 * on it. `cats` line added; `catNumber` stays as the presentational
 * headline (lowest number in the bundle). Hard break from v2 —
 * v2 signatures never verify under v3.
 */
declare const CAT21_LISTING_MESSAGE_VERSION = "v3";
/**
 * The fields the listing message covers, in the fixed canonical
 * order. Every consumer (seller's wallet during signing, backend
 * during verification, external mirror during re-verification)
 * builds the message via `buildListingMessage()` — never
 * concatenates fields directly.
 */
type ListingMessageFields = Pick<Cat21Listing, 'catNumber' | 'cats' | 'network' | 'askSats' | 'payTo' | 'catTxid' | 'catVout' | 'ordinalsAddress' | 'signedAt'>;
/**
 * Build the canonical human-readable message the seller signs with
 * their ordinals wallet. Multi-line by design — the wallet's
 * signature prompt renders this as-is, and the seller reads it
 * before approving. Fixed order, fixed separator, fixed prefix.
 *
 * Any drift between the seller's version and the verifier's version
 * (added field, reordered line, changed separator) breaks the
 * signature. The version prefix (`cat21-ask:vN`) is the escape
 * hatch: bump when the schema changes so old + new signatures don't
 * confuse the verifier.
 *
 * Example message the seller sees in their wallet:
 *
 * ```
 * cat21-ask:v3
 * network=mainnet
 * catNumber=42
 * cats=42,100,500
 * askSats=21000
 * payTo=bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx
 * catTxid=ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df
 * catVout=0
 * ordinalsAddress=bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9
 * signedAt=1700000000
 * ```
 */
declare function buildListingMessage(fields: ListingMessageFields): string;
/**
 * Canonicalise + validate the `cats` bundle. Ascending sort + dedup
 * so the seller's signed bytes are the same regardless of the order
 * their UI hands them over. Emits comma-separated: `0,42,100`.
 *
 * `catNumber` (the headline) MUST be one of the bundle entries —
 * displaying a headline that isn't in the bundle would let a seller
 * hide the fact that the UTXO also carries a lower-numbered cat.
 */
declare function serializeCats(cats: number[], headlineCatNumber: number): string;
/**
 * Parse the `cats=` line of a canonical listing message back into a
 * sorted, deduped number array. Inverse of serializeCats — used by
 * external mirrors verifying signatures without a full backend.
 */
declare function parseCatsList(csv: string): number[];

/**
 * Result of `verifyListingSignature`. On success, `ok: true` — the
 * BIP-322 signature is valid for the given ordinals address AND the
 * message it commits to matches the listing fields byte-for-byte.
 * On failure, `ok: false` with a `reason` code the caller (backend
 * insert path, frontend re-verifier) can log / show.
 */
type VerifyListingSignatureResult = {
    ok: true;
} | {
    ok: false;
    reason: VerifyListingRejectionReason;
    detail?: string;
};
type VerifyListingRejectionReason = 'malformed-signature' | 'unsupported-address-type' | 'invalid-address' | 'signature-does-not-verify';
/**
 * Verify a BIP-322 "simple" signature over the canonical listing
 * message, for a P2TR ordinals address.
 *
 * The BIP-322 primitive itself lives in
 * `../wallet/verify-bip322-signature.ts`; this function is the
 * listing-shaped wrapper that (a) rebuilds the canonical message
 * from the listing fields and (b) reuses the shared primitive.
 * The listing-shape validation (cats-bundle sanity, headline
 * membership, MAX_ASK_SATS) lives in `buildListingMessage` — a
 * caller who hands us structurally-broken fields cannot have a
 * signature that verifies against a canonical rebuild, so we
 * collapse a build-time throw into the same `signature-does-not-
 * verify` reason the caller already handles.
 */
declare function verifyListingSignature(args: {
    fields: ListingMessageFields;
    signatureBase64: string;
}): VerifyListingSignatureResult;

/**
 * Session-token capability layer for cat21 marketplace operations.
 *
 * The idea: instead of prompting the user for a BIP-322 signature
 * on every capability action (delete listing, delete bid, future
 * my-cats view), prompt ONCE per session for a canonical message
 * of the form
 *
 *   `Cat21 session: I control <address>, valid until <ISO>`
 *
 * The client caches the signed message + signature in localStorage,
 * keyed by the ordinals address. Every subsequent capability request
 * attaches three headers (address, message, signature); the backend
 * verifies via BIP-322 and honours the request iff the timestamp is
 * still in the future AND the header address matches the target of
 * the action.
 *
 * Threat model: a session token is a bearer capability for the
 * validity window. It is intentionally SEPARATE from per-artifact
 * signatures (per-listing BIP-322, per-bid PSBT SIGHASH_ALL), which
 * remain the tamper-proof marketplace record. The session token is
 * ONLY used for actions whose intent doesn't need to survive
 * independently as a public artifact — namely deletes and future
 * "show me my stuff" reads.
 *
 * See workspace CLAUDE.md for the philosophical rationale: the
 * marketplace layer is convenience; the real security is PSBT +
 * Bitcoin as the ledger. A leaked session token can grief the
 * marketplace (spurious delete, spurious future-my-cats read) but
 * cannot cost anyone Bitcoin.
 */
/**
 * Default validity window. Long enough that most users won't hit an
 * expiry prompt in a normal browsing session; short enough that a
 * leaked token from a single-tab XSS doesn't stay valid for weeks.
 */
declare const CAT21_SESSION_VALIDITY_MS: number;
/**
 * Absolute cap so a caller can't hand-craft a session valid until
 * year 3000. Backend rejects `validUntil` further out than this.
 */
declare const CAT21_SESSION_MAX_VALIDITY_MS: number;
/**
 * Build the canonical UTF-8 message the user signs to prove control
 * of `address` until `validUntilIso`.
 *
 * Deterministic — same inputs always produce the same bytes — so the
 * backend can rebuild the message from headers and hand it to
 * `verifyBip322Signature`.
 *
 * Format is a single line; the ISO-8601 timestamp uses second
 * precision (backend truncates any sub-second component on
 * comparison) so a wallet's local clock jitter can't produce a
 * different message than the one it signed.
 */
declare function buildCat21SessionMessage(args: {
    address: string;
    validUntilIso: string;
}): string;
/**
 * Verify the ISO timestamp is well-formed AND still in the future.
 * Returns null on ok, or a reason string on failure. Callers use
 * this at both ends of the wire:
 *
 *   - client: skip a cached session whose `validUntilIso` is past
 *   - server: reject an incoming header with a past `validUntilIso`
 */
declare function checkSessionValidity(validUntilIso: string, nowMs: number): null | 'malformed-timestamp' | 'session-expired' | 'session-too-far-in-future';

/**
 * Result of `verifyBip322Signature`. On success, `ok: true` — the
 * BIP-322 "simple" signature is valid for the given P2TR ordinals
 * address over the given UTF-8 message. On failure, `ok: false`
 * with a reason code the caller can log / surface.
 *
 * The reasons intentionally match the shape used by
 * `verifyListingSignature` so backend rejection error codes stay
 * uniform across every BIP-322 verification path.
 */
type VerifyBip322SignatureResult = {
    ok: true;
} | {
    ok: false;
    reason: VerifyBip322RejectionReason;
    detail?: string;
};
type VerifyBip322RejectionReason = 'malformed-signature' | 'unsupported-address-type' | 'invalid-address' | 'signature-does-not-verify';
/**
 * Verify a BIP-322 "simple" signature over an arbitrary UTF-8
 * message, for a P2TR ordinals address.
 *
 * P2TR is the only address type supported today — every wallet the
 * SDK integrates puts ordinals on taproot. If a future wallet stores
 * cats on a non-taproot address, add a P2WPKH branch here.
 *
 * ### The BIP-322 "simple" verification recipe
 *
 * BIP-322 defines two virtual transactions the signature commits to:
 *
 *   `to_spend`: a synthetic tx with input from an all-zeros outpoint
 *   whose scriptSig is `OP_0 PUSH32 tagged_hash("BIP0322-signed-
 *   message", message)`, and output paying to the signer's address.
 *
 *   `to_sign`: a synthetic tx spending `to_spend[0]`, with a single
 *   `OP_RETURN` output and a witness holding the wallet's signature.
 *
 * For a P2TR key-path spend, the witness stack is a single 64- or
 * 65-byte schnorr signature. The verifier:
 *
 *   1. Rebuilds `to_spend` from the message + signer's script.
 *   2. Rebuilds `to_sign` referencing `to_spend[0]`.
 *   3. Computes the BIP-341 taproot sighash for `to_sign` spending
 *      `to_spend[0]` under the wallet-supplied sighash byte.
 *   4. Runs `schnorr.verify(sig, sighash, xonly_pubkey)`.
 *
 * See https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 * for the full spec.
 */
declare function verifyBip322Signature(args: {
    address: string;
    message: string;
    signatureBase64: string;
}): VerifyBip322SignatureResult;

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
    /** Body encoding hint (e.g. `gzip`, or `br` for brotli). */
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
declare function buildInscriptionEnvelope(args: BuildInscriptionEnvelopeArgs): Uint8Array;
/**
 * Encode an inscription id (`<txid>i<index>`) into the byte form ord
 * expects wherever an inscription id appears in an envelope value:
 * tag 0x03 (`parent`), tag 0x0b (`delegate`), and gallery items:
 *
 *   [ 32 bytes: reversed txid ][ 0..4 bytes: little-endian index, trailing zeros trimmed ]
 *
 * Zero-index gets no trailing bytes; index 256 encodes as `[0x00, 0x01]`;
 * index 0xFFFFFFFF (u32 max) encodes as `[0xFF, 0xFF, 0xFF, 0xFF]`.
 *
 * Byte-for-byte inverse of `ordpool-parser`'s `extractInscriptionId`,
 * which is what ordpool renders parents / delegates from. If the
 * round-trip doesn't match, the parser drops the id silently (ord's
 * `filter_map` semantics), so the caller MUST hand us a canonical id
 * form.
 */
declare function encodeInscriptionId(inscriptionId: string): Uint8Array;
/**
 * Backwards-compatible alias. `parent` (tag 0x03) and `delegate`
 * (tag 0x0b) share the same inscription-id byte form, so both go
 * through `encodeInscriptionId`. Kept exported because consumers +
 * specs already import this name.
 */
declare const encodeParentInscriptionId: typeof encodeInscriptionId;
/**
 * Encode a pointer sat-offset (tag 0x02) as minimal little-endian
 * bytes: the u64 offset with trailing zero bytes trimmed. Offset 0
 * encodes as an empty push (ord reads a missing/empty value as 0);
 * 255 → `[0xff]`; 256 → `[0x00, 0x01]`.
 *
 * Inverse of `ordpool-parser`'s `extractPointer`, which little-endian-
 * decodes the value. The pointer names the sat position (in the
 * concatenated outputs) the inscription is assigned to; only the
 * builder knows whether that offset is reachable given the reveal's
 * output topology, so range-vs-topology validation lives at the
 * synthesis layer, not here.
 */
declare function encodePointerValue(offset: number): Uint8Array;
/**
 * Encode a rune-name commitment (tag 0x0d) as minimal little-endian
 * bytes: the rune's u128 value with trailing zero bytes trimmed.
 * Value 0 encodes as an empty push. Rejects negatives and anything
 * above u128 max.
 *
 * ord's rune etching reads this back as the u128 commitment (see
 * `ordpool-parser` `knownFields.rune`); the etching tx must later
 * spend this inscription's UTXO. A pre-computed byte value can still
 * be passed through the generic `envelopeFields` escape hatch.
 */
declare function encodeRuneCommitment(value: bigint): Uint8Array;
/**
 * Split a field value into one-or-more `{ tag, value }` entries so no
 * single push exceeds the 520-byte standardness cap. ord's decoder
 * concatenates all same-tag chunks before decoding (metadata tag 0x05,
 * properties tag 0x11), so a large CBOR blob is carried as several
 * repeated-tag fields.
 *
 * A zero-length value yields a single empty-value field (callers that
 * reject empty payloads gate that upstream).
 */
declare function chunkFieldValue(tag: OrdTag, value: Uint8Array): OrdEnvelopeField[];

/**
 * Deterministic CBOR encoder for inscription metadata + properties.
 *
 * ## Why this lives in the SDK, not in ordpool-parser
 *
 * ordpool-parser owns the CBOR *decoder* (`lib/cbor.ts`, `CBOR.decode`)
 * and is a zero-dependency *decode* library; nothing there ever encodes
 * CBOR. The inscribe pipeline is the only place in the whole ecosystem
 * that *builds* inscriptions, so it is the only CBOR *producer*. That
 * mirrors the existing split exactly: the envelope encoder
 * (`buildInscriptionEnvelope`) is described in its own module doc as
 * "the inverse of ordpool-parser's InscriptionParserService" and it
 * lives here in the SDK, not in the parser. This CBOR encoder is the
 * same shape of thing (the inverse of `CBOR.decode`), so it belongs
 * next to the envelope encoder it feeds.
 *
 * The correctness oracle is still the parser: every value this encoder
 * produces round-trips through ordpool-parser's `CBOR.decode` in the
 * spec, so encoder and decoder stay pinned as inverses.
 *
 * ## Deterministic = canonical (RFC 8949 §4.2)
 *
 * "Deterministic" here means the same logical value always produces the
 * same bytes. That property matters for a signing library: identical
 * metadata must yield an identical inscription envelope, hence an
 * identical commit address, so a retried inscribe is idempotent and
 * reproducible.
 *
 * The encoder implements RFC 8949 §4.2.1 core rules:
 *   - integers use the shortest encoding that fits;
 *   - all lengths are definite (never indefinite/streaming);
 *   - map keys are sorted in bytewise lexicographic order of their
 *     own deterministic encodings, and duplicate keys are rejected.
 *
 * Non-integer numbers are emitted as float64 (§4.2.2's shortest-float
 * preference is NOT implemented; metadata rarely carries floats, and
 * float64 is already deterministic: the same double always encodes to
 * the same 8 bytes). Everything else is fully canonical.
 *
 * ## Supported types
 *
 *   number   → integer (major 0/1) if a safe integer, else float64
 *   bigint   → integer (major 0/1), range [-(2^64), 2^64 - 1]
 *   string   → UTF-8 text string (major 3)
 *   Uint8Array / any ArrayBuffer view → byte string (major 2)
 *   boolean  → 0xf5 (true) / 0xf4 (false)
 *   null     → 0xf6
 *   Array    → array (major 4)
 *   Map      → map (major 5) with number | bigint | string keys
 *   object   → map (major 5) with string keys (own enumerable)
 *
 * `undefined`, functions, and symbols throw: CBOR has no faithful,
 * unambiguous encoding for them and silently dropping them would make
 * the output non-deterministic w.r.t. the input.
 *
 * ## Two round-trip caveats worth knowing
 *
 * 1. **Integers above 2^53 are exact on chain, lossy back through the
 *    parser.** This encoder emits correct CBOR for the full u64 range,
 *    and ord's own (Rust) decoder reads it exactly. But
 *    ordpool-parser's `CBOR.decode` returns every integer as a JS
 *    `number` (`readUint32()*2^32 + readUint32()`), which loses
 *    precision above `Number.MAX_SAFE_INTEGER`. So a u64 metadata value
 *    displays exactly in ord but may render off-by-a-few on ordpool. If
 *    you need an exact round-trip through the parser, carry large
 *    integers as a byte string.
 *
 * 2. **Integer CBOR map keys require a `Map`, not a plain object.** ord's
 *    properties struct (tag 0x11) is integer-keyed. A plain object
 *    `{0: gallery, 1: attrs}` has STRING keys (`"0"`, `"1"`), which this
 *    encoder faithfully emits as CBOR text-string keys; real ord then
 *    fails to deserialize the integer-keyed struct and drops the field.
 *    ordpool-parser happens to accept text keys via JS coercion, so a
 *    round-trip test with a plain object passes while the real chain
 *    ignores it. Build integer-keyed CBOR (properties, gallery items)
 *    with a `Map` whose keys are real numbers.
 */
/**
 * Encode a value as canonical (deterministic) CBOR.
 * Throws on unsupported inputs rather than emitting lossy bytes.
 */
declare function encodeCborDeterministic(value: unknown): Uint8Array;

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
 *          signs). Sequence is wallet-specific via
 *          `resolveCat21MintInputSequence(walletType)`: 0xfffffffd for
 *          cat21wallet (RBF allowed; our wallet preserves
 *          lockTime=21 through replacement), 0xfffffffe for every
 *          third-party wallet (RBF disabled; locks accelerate UIs
 *          out, the 2024 Xverse incident defence).
 *        - Output 0: the commit P2TR address holding
 *          `postage + revealFeeReserve + tipValueSats` (the last
 *          term only when `tipValueSats > 0` on the reveal). The
 *          reveal spends this.
 *        - Output 1 (optional): change back to the user, if the
 *          funding input has surplus above commit fee + output 0.
 *
 *   3. `nLockTime=21`: the commit qualifies as a CAT-21 mint under
 *      cat21-ord's `--index-cat21` rule. The first sat of vout[0]
 *      becomes Cat A (`<commitTxid>i0`). The reveal then spends
 *      vout[0] FIFO-style, moving Cat A to the inscription's UTXO,
 *      and the reveal itself (also `nLockTime=21`) mints Cat B
 *      (`<revealTxid>i0`) at the same satpoint. Net: two cats per
 *      inscribe, stacked on the inscription's 546-sat UTXO. The
 *      maintainer's design: "we gift the cats for free. because
 *      why not."
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
    /**
     * Which wallet will sign the commit PSBT. Drives the funding
     * input's sequence number via `resolveCat21MintInputSequence`:
     *   - `cat21wallet`: 0xfffffffd (RBF-allowed; our wallet preserves
     *     `lockTime=21` through any replacement).
     *   - any other wallet (default): 0xfffffffe (non-RBF; locks
     *     third-party accelerate UIs out of touching the marker,
     *     defending against the 2024 Xverse incident where an
     *     accelerator dropped `lockTime=21` and burned a CAT-21 mint).
     *
     * Defaults to a non-cat21wallet sentinel so any standalone caller
     * (regtest specs, third-party SDK consumers) gets the safer
     * non-RBF sequence without having to know about the rule.
     */
    walletType?: KnownOrdinalWalletType;
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
    /**
     * Sat value the commit places at output 0. Equals
     * `postage + revealFeeReserveSats + (tipValueSats ?? 0)`. Funds
     * the reveal's recipient output + optional tip output + reveal
     * miner fee in a single P2TR commit.
     */
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
 *   - Output 0: `recipientAddress` for postage sats. Per ord theory,
 *     the inscription lands on the first sat of the first output.
 *   - Output 1 (optional): tip address for `tip.value` sats. Skipped
 *     when `tip` is omitted or `tip.value === 0`.
 *   - `nLockTime=21`: the reveal qualifies as a CAT-21 mint under
 *     cat21-ord's `--index-cat21` rule. Combined with the commit
 *     (which also sets `nLockTime=21`), every inscription mints two
 *     cats stacked at the inscription's satpoint. See the commit
 *     helper's module doc for the cat-mint semantic.
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
    /**
     * Sat value at the commit output. Equals
     * `postage + revealFeeReserve + (tip.value ?? 0)`; the orchestrator
     * threads this through the fee simulator so the reveal has the sats
     * to fund recipient + tip + miner fee.
     */
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
     * or when `tip.value === 0`, no tip output is appended and the
     * reveal has its recipient output at vout[0] only.
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
 * Layer-1 builder for a **child** inscription's reveal transaction —
 * ord provenance (parent/child), the trustless way to prove a child was
 * created by the owner of the parent.
 *
 * # What makes a valid parent link (ord spec, verified against
 * `inscription_updater.rs` + `plan.rs`)
 *
 * ord recognises `P` as the parent of child `C` iff BOTH hold:
 *   1. `C`'s envelope carries the `parent` tag (0x03) = P's inscription
 *      id (this builder's caller emits that via the envelope, same as a
 *      normal inscribe).
 *   2. **P's UTXO is spent as an input of C's reveal transaction.** The
 *      indexer builds `potential_parents` from the inscriptions present
 *      in the tx and drops any declared parent not in that set
 *      (`inscription_updater.rs:253-269`). Emitting the tag WITHOUT
 *      spending P produces a valid child with NO recognised parent.
 *
 * # Topology (matches ord's own wallet, `plan.rs:392-425`)
 *
 * ```
 * Inputs:   [ parent UTXO (0),           commit output (1) ]
 * Outputs:  [ parent RETURN (0, = P val), child recipient (1, 546) , tip? ]
 * ```
 *
 * FIFO sat-tracking makes this correct with NO pointer:
 *   - Input 0 (parent, P sats) → global `[0..P)` → Output 0 → the parent
 *     inscription RETURNS to its owner. Nothing is lost.
 *   - Input 1 (commit) first sat → global `P` → Output 1 → the child
 *     inscription lands on its recipient (the default offset is "first
 *     sat of the inscription's own input", `inscription_updater.rs:207-211`).
 *
 * Because the child's envelope is on a non-first input (input 1), ord
 * marks it `Curse::NotInFirstInput` → **post-jubilee that is a normal,
 * positively-numbered inscription with the `Vindicated` charm** (mainnet
 * + our regtest are post-jubilee). This is exactly how ord's own
 * `wallet inscribe --parent` produces children; the charm is cosmetic and
 * provenance is unaffected.
 *
 * # Two signers
 *
 * The reveal is co-signed:
 *   - **Commit input (1)** — the ephemeral key, script-path via the
 *     envelope leaf, finalized here (SIGHASH_DEFAULT over the whole tx).
 *   - **Parent input (0)** — the parent OWNER's wallet (P2TR key-path).
 *     Left UNSIGNED in the returned PSBT; the orchestrator hands it to
 *     the wallet, which signs input 0, then we finalize + broadcast.
 * Both sign SIGHASH_ALL/DEFAULT over the same fixed inputs+outputs, so
 * order is irrelevant and neither invalidates the other.
 */
/** A parent inscription being spent + returned by the child reveal. */
interface ChildRevealParent {
    /** The parent inscription's current UTXO (P2TR — an ordinals address). */
    utxo: {
        txid: string;
        vout: number;
        /** Sat value at the parent UTXO; the parent RETURNS with exactly this value. */
        value: number;
        /** scriptPubKey of the parent UTXO (P2TR). */
        scriptPubKey: Uint8Array;
        /** x-only internal key of the parent's P2TR address (for wallet key-path signing). */
        tapInternalKey: Uint8Array;
    };
    /**
     * Where the parent inscription returns to — the owner's ordinals
     * address. For the in-wallet case this is the SAME wallet that owns
     * the parent (the inscription goes back where it came from).
     */
    returnAddress: string;
}
interface ChildInscribeRevealArgs {
    /** Commit txid (the child's commit; same commit builder as a normal inscribe). */
    commitTxid: string;
    /** Commit output index — always 0. */
    commitVout: number;
    /** Sat value at the commit output (funds child postage + reveal fee + tip). */
    commitOutputValueSats: number;
    /** scriptPubKey of the commit output. */
    commitOutputScript: Uint8Array;
    /** Taptree spend metadata from the commit builder. */
    taproot: {
        internalKey: Uint8Array;
        tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
    };
    /** 32-byte ephemeral private key (same key embedded in the envelope). */
    ephemeralPrivKey: Uint8Array;
    /** The parent inscription spent + returned by this reveal. */
    parent: ChildRevealParent;
    /** Address the CHILD inscription lands on (P2TR recommended). */
    recipientAddress: string;
    /** Optional tip output, appended after the child output. */
    tip?: {
        address: string;
        value: number;
    };
    network: Network;
}
interface ChildInscribeRevealResult {
    /**
     * Reveal PSBT bytes. Input 0 (parent) is UNSIGNED — the wallet signs
     * it. Input 1 (commit) is already finalized with the ephemeral
     * signature. Finalize input 0 after the wallet signs, then broadcast.
     */
    revealPsbt: Uint8Array;
    /** Reveal txid (witness-independent; stable before the wallet signs). */
    revealTxid: string;
    /** Reveal vsize (fully-signed) for fee math. */
    revealVsize: number;
}
/**
 * Build the child reveal PSBT: parent input (unsigned) + commit input
 * (ephemeral-finalized), parent-return output + child output.
 */
declare function buildChildInscribeRevealTx(args: ChildInscribeRevealArgs): ChildInscribeRevealResult;

/**
 * Layer-2 input adapter for the CAT-21 inscribe pipeline. Thin wrapper
 * over the shared `prepareCat21Input` (same body the mint / transfer /
 * offer adapters delegate to). Turns a raw funding UTXO + the wallet's
 * payment details into the funding-input shape `buildInscribeCommitPsbt`
 * consumes.
 */
type InscribeFundingInput = Cat21PreparedInput;
type PrepareInscribeFundingInputArgs = PrepareCat21InputArgs;
declare function prepareInscribeFundingInput(args: PrepareInscribeFundingInputArgs): InscribeFundingInput;

/**
 * Layer-3 fee simulation for the inscribe commit + reveal pair.
 *
 * The two transactions pay independent fees at the same `feeRate`:
 *
 *   commit_fee = ceil(commitVsize × feeRate)
 *   reveal_fee = ceil(revealVsize × feeRate)
 *
 * The reveal's vsize is **deterministic given the envelope and
 * the tip presence** (input = commit output; outputs = recipient
 * at postage + optional tip at `tip.value`; witness = envelope
 * script + Schnorr sig + control block) so we compute it once via
 * a one-shot simulation. The commit's vsize depends on
 * whether the change output crosses the dust limit at the
 * resolved fee, so we run the cat21-style two-pass loop on the
 * commit alone, passing `revealFeeReserveSats = reveal_fee`.
 *
 * Net cost: 1 reveal simulation + 2 commit simulations = 3 builds.
 *
 * Universal fee strategy that matches every inscriber in the
 * verified OSS catalog (ord client, micro-ordinals examples,
 * ordit-sdk, 0xFlicker, LaserEyes — see
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
    /**
     * Wallet whose signature topology drives the commit's funding-
     * input sequence. Threaded through to `buildInscribeCommitPsbt`.
     * Optional; defaults to the safer non-RBF sequence when omitted.
     */
    walletType?: KnownOrdinalWalletType;
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
    /**
     * Amount the commit output 0 holds = postage + revealFeeSats +
     * (tip.value ?? 0) — sized to fund the reveal's recipient
     * + optional tip + miner fee in one P2TR output.
     */
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
 * Isomorphic inscription-body compression (browser + Node).
 *
 * Inscription bytes go on-chain at real sat/vB; compressing HTML / JSON /
 * SVG / text before inscribing is a direct fee win. ord recognises a
 * compressed body via the `content_encoding` envelope tag (0x09) and
 * serves it back with a matching HTTP `Content-Encoding` header, so the
 * viewing browser transparently decompresses it (see cat21-ord
 * `src/subcommand/server/r.rs`). Browsers always send `Accept-Encoding:
 * gzip, deflate, br`, so both `gzip` and `br` bodies render everywhere
 * ordinals do; brotli typically lands ~15-20% smaller than gzip on
 * text/SVG/JSON.
 *
 * # Codecs: native first, wasm brotli only where forced
 *
 * - **gzip** — native `CompressionStream('gzip')` everywhere (Node 18+,
 *   all modern browsers). The universal baseline.
 * - **brotli, native** — `CompressionStream('brotli')` where the runtime
 *   has it: Safari 18.4+, Firefox 147+, Node 24.7+, Deno 2.7+ (brotli was
 *   added to the WHATWG Compression Standard in 2026). Zero dependency,
 *   no fetch.
 * - **brotli, wasm fallback** — Chrome/Edge (Blink) deliberately don't
 *   ship the brotli compression dictionary, so there is no native encoder
 *   there. For those runtimes {@link assessCompression} uses the reference
 *   Rust brotli compiled to wasm (see {@link ./brotli-wasm-encoder}), but
 *   ONLY when the caller passes `brotliWasmUrl`. The `.wasm` is a hosted
 *   PACKAGE ASSET the consumer serves from its own origin and is fetched
 *   on demand — it never bloats the JS bundle. Omit the URL and Chrome
 *   simply falls back to gzip.
 *
 * Immutable-data safety: every encoder here is the platform's zlib or the
 * reference Rust brotli — never hand-rolled — so an encoder bug can't
 * corrupt an inscription. Decoding lives in `ordpool-parser`
 * (`brotliDecode` / native `DecompressionStream`).
 *
 * # Async on purpose
 *
 * The Compression Streams API is a stream API, so the primitives return
 * Promises. Callers `await` them; the inscribe builder stays sync because
 * compression happens at the call site BEFORE `createInscribeTransactions`
 * (see {@link assessCompression}).
 *
 * # Reuse beyond inscribe (cubes)
 *
 * {@link assessCompression} is deliberately generic (arbitrary bytes + a
 * content-type). cubes-frontend's cube HTML is highly compressible text,
 * so cubes can adopt it for its cube inscriptions with no inscribe-specific
 * coupling. This file ships in `dist-core`, so both browser consumers
 * import it from `ordpool-sdk/core`.
 */
/**
 * Body encodings the inscribe builder can tag on-chain (`content_encoding`,
 * tag 0x09). `'gzip'` is what {@link assessCompression} produces here;
 * `'br'` remains valid for a consumer that brings its own brotli bytes
 * (the builder emits whichever tag; only the decoder needs to exist, and
 * it lives in `ordpool-parser`). Exported as a runtime tuple so the
 * inscribe operation-gate can validate untrusted input against it.
 */
declare const INSCRIPTION_CONTENT_ENCODINGS: readonly ["br", "gzip"];
type InscriptionContentEncoding = typeof INSCRIPTION_CONTENT_ENCODINGS[number];
/**
 * Compress `body` with gzip via the native Compression Streams API. Works
 * in the browser AND Node. Returns a fresh `Uint8Array` (gzip stream:
 * magic `1f 8b`).
 */
declare function compressGzip(body: Uint8Array): Promise<Uint8Array>;
/**
 * Whether the runtime has a native `CompressionStream('brotli')` encoder:
 * true on Safari 18.4+, Firefox 147+, Node 24.7+, Deno 2.7+; false on
 * Chrome/Edge (Blink), which deliberately don't ship the brotli compression
 * dictionary. Construction throws synchronously for an unsupported format,
 * so this is a cheap sync feature test.
 */
declare function nativeBrotliAvailable(): boolean;
/**
 * Decompress a gzip `body` via the native Compression Streams API. The
 * inverse of {@link compressGzip}; used to verify a `content_encoding:
 * 'gzip'` body recovers its original bytes.
 *
 * Mirrors `ordpool-parser`'s `gzipDecode` decompression-bomb guard: the
 * running output is capped at {@link MAX_DECOMPRESSED_SIZE} and the stream
 * is cancelled the instant it would be exceeded. Unlike the parser's
 * render-path variant (which returns an error string as bytes so rendering
 * never throws), this verify-path variant THROWS on a bomb or on invalid
 * data, because a caller checking a round-trip wants the failure surfaced.
 */
declare function decompressGzip(body: Uint8Array): Promise<Uint8Array>;
/**
 * The facts a consumer needs to decide whether to inscribe a body
 * compressed. {@link assessCompression} NEVER decides silently: it hands
 * back the numbers + the winning bytes and the caller/UI picks yes/no.
 */
interface CompressionAssessment {
    /**
     * `true` when compressing meaningfully shrinks the body (smaller by at
     * least the minimum margin). The caller inscribes `compressed` +
     * `contentEncoding: bestEncoding` only when this is `true`.
     */
    worthIt: boolean;
    /**
     * The winning codec's `content_encoding` tag value when `worthIt`, else
     * `'none'` (inscribe `compressed` — the original bytes — uncompressed,
     * no `content_encoding` tag). `'br'` is produced where a brotli encoder
     * is available: native `CompressionStream('brotli')`, or the wasm encoder
     * when the caller passes `brotliWasmUrl`.
     */
    bestEncoding: 'none' | InscriptionContentEncoding;
    /** Byte length of the original body. */
    originalSize: number;
    /** Byte length of `compressed` (equals `originalSize` when `bestEncoding === 'none'`). */
    compressedSize: number;
    /** `originalSize - compressedSize` (0 when not worth it / short-circuited). */
    savedBytes: number;
    /** `savedBytes / originalSize * 100`, rounded to 2 decimals (0 when `originalSize` is 0). */
    savedPercent: number;
    /**
     * When `worthIt`, the compressed bytes to inscribe (so the caller never
     * compresses twice). When not worth it, the ORIGINAL bytes (the body to
     * inscribe uncompressed).
     */
    compressed: Uint8Array;
}
interface AssessCompressionOptions {
    /**
     * Minimum saving (percent of the original) required to report
     * `worthIt: true`. Default 5%. Rationale: the `content_encoding`
     * envelope tag itself costs a few bytes on-chain and gzip adds a small
     * framing overhead, so a sub-few-percent "saving" can be a net loss once
     * the tag is counted; 5% clears that comfortably for any non-trivial
     * body. A consumer with different economics can override it.
     */
    minSavedPercent?: number;
    /**
     * URL of a hosted `brotli_wasm_bg.wasm` (shipped in this package under
     * `wasm/`; the consumer app copies it to its own origin and passes that
     * URL). ONLY used on runtimes WITHOUT native `CompressionStream('brotli')`
     * — i.e. Chrome/Edge — to fetch + instantiate the wasm brotli encoder on
     * demand (once, cached). Omit it and Chrome/Edge simply fall back to gzip;
     * Safari/Firefox/Node use native brotli and never touch this.
     */
    brotliWasmUrl?: string;
}
/**
 * Assess whether inscribing `bytes` compressed is worth it, trying every
 * available codec (gzip, plus brotli where an encoder exists) and returning
 * the smallest winner. Pure
 * assessment: emits NO envelope tag, makes NO inscribe-specific
 * assumptions, and returns everything the caller needs to decide. Generic
 * enough for cubes-frontend to call on arbitrary cube HTML.
 *
 * Behaviour:
 *   - Known already-compressed `contentType` (image/*, video, zip, woff2,
 *     …) → short-circuits to `worthIt: false`, `bestEncoding: 'none'`
 *     WITHOUT running any compressor (`compressed` = the original bytes).
 *   - Otherwise compresses once per codec, keeps the smallest output, and
 *     sets `worthIt = savedBytes > 0 && savedPercent >= minSavedPercent`.
 *     The `savedBytes > 0` term also guards the "compressed output larger
 *     than the original → not worth it" case. On a size tie the earlier
 *     codec wins (gzip; see {@link buildCodecs}). The winning bytes are
 *     returned so the caller reuses them (never compresses twice).
 */
declare function assessCompression(bytes: Uint8Array, contentType?: string, options?: AssessCompressionOptions): Promise<CompressionAssessment>;

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
 * # Free cats (the "ordpool inscribers get cats" design)
 *
 * Both the commit AND the reveal carry `nLockTime=21`, so cat21-ord
 * mints TWO cats per inscription:
 *   - Cat A: `<commitTxid>i0` — minted by the commit; ends up at
 *     the inscription's UTXO via FIFO transitivity through the
 *     reveal's input.
 *   - Cat B: `<revealTxid>i0` — minted by the reveal at the same
 *     satpoint. Post-jubilee chains tag Cat B with the `Vindicated`
 *     charm; it's otherwise a normal cat with a positive number.
 * Both cats stack on the inscription's 546-sat UTXO at the
 * recipient's address. No opt-out. See the commit helper's module
 * doc for the cat21-ord index mechanics.
 *
 * # Lifecycle
 *
 *  1. Generate fresh ephemeral keypair (32 random bytes).
 *  2. Derive Schnorr x-only pubkey — this doubles as the envelope's
 *     `<pubkey> CHECKSIG` prefix AND the taproot internal key of the
 *     commit output.
 *  3. Build envelope with caller's content + auto-prepended fields
 *     (note → tag 0x0f UTF-8; contentEncoding → tag 0x09, the encoding
 *     string e.g. "gzip" / "br")
 *     + any caller-supplied `envelopeFields`.
 *  4. Simulate fees (Layer 3): commitFee, revealFee,
 *     commitOutputValueSats (= postage + revealFee + tip.value),
 *     fundingRequirementSats.
 *  5. Build the commit PSBT at the resolved commitFee with
 *     `nLockTime=21` and the per-wallet sequence.
 *  6. Build a default reveal tx at the resolved revealFee using the
 *     ephemeral private key (recipient = `args.recipientAddress`,
 *     optional tip at vout[1], also `nLockTime=21`).
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
     * Which wallet will sign the commit. Drives the funding-input
     * sequence number on the commit (cat21wallet → RBF allowed; every
     * other wallet → RBF disabled). Optional; the safer non-RBF
     * sequence applies when omitted, which is what every third-party
     * wallet should ship anyway.
     *
     * Ordpool inscriptions ALWAYS build the commit with
     * `nLockTime=21` regardless of wallet — see the module-level
     * docstring for the "free cat for inscribers" design.
     */
    walletType?: KnownOrdinalWalletType;
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
    /**
     * Optional Tag::Note (0x0f) string. Emitted as a UTF-8 envelope
     * field; ordpool-parser surfaces it on the inscription record.
     * The de-facto inscriber-tool watermark slot.
     *
     * When set, the SDK auto-builds the `{ tag: 0x0f, value: utf8(note) }`
     * field and prepends it to `envelopeFields`.
     */
    note?: string;
    /**
     * Optional parent inscription id (`<txid>i<index>`) for provenance
     * chains. Emitted as a Tag::Parent (0x03) envelope field.
     *
     * IMPORTANT: setting this ONLY emits the envelope tag. Ord treats
     * an inscription as a genuine child only when the reveal tx ALSO
     * spends the parent's UTXO as an input — which requires the
     * parent owner co-signing the reveal, a topology change this
     * builder does not model. Consumers using `parent` today get the
     * annotation (ordpool-parser surfaces the parent id), not the
     * provenance link. Full parent/child support needs its own
     * orchestrator.
     */
    parent?: string;
    /**
     * Optional body-encoding hint. When set, the SDK emits the
     * `content_encoding` envelope tag (0x09) with this exact string,
     * signalling to indexers + ord that the body is compressed with that
     * codec. The body must ALREADY be compressed by the caller; this flag
     * only emits the tag.
     *
     * Compression is a deliberate, explicit consumer step (never hidden in
     * this builder): call `assessCompression(bytes, contentType)` from
     * `inscribe-compression.helper.ts`, show the savings, and if you choose
     * to compress pass its `compressed` body here with
     * `contentEncoding: assessment.bestEncoding`. `assessCompression` /
     * `compressGzip` are async + isomorphic (native Compression Streams),
     * so the compression happens at the call site before this sync builder
     * runs. `'br'` is also accepted for a caller that brings its own brotli
     * bytes (the decoder lives in `ordpool-parser`).
     */
    contentEncoding?: InscriptionContentEncoding;
    /**
     * Optional pointer (tag 0x02): the sat offset, within the reveal's
     * concatenated outputs, the inscription is assigned to. Emitted as
     * minimal little-endian bytes.
     *
     * TOPOLOGY CAVEAT: this builder's reveal has the inscription's own
     * 546-sat recipient output at vout[0] (plus an optional tip at
     * vout[1]). A pointer only lands on the inscription's UTXO when it
     * points inside that first output, i.e. `pointer < 546`. A larger
     * offset would move the inscription onto the tip output or past the
     * end of the outputs (unreachable, and not what any single-inscription
     * caller wants), so values `>= 546` are rejected rather than silently
     * emitted. Default (unset) behaves like pointer 0.
     */
    pointer?: number;
    /**
     * Optional CBOR metadata (tag 0x05). Pass the ALREADY-CBOR-ENCODED
     * bytes: use the exported `encodeCborDeterministic(value)` helper to
     * turn a structured value into canonical CBOR first. Values over 520
     * bytes are split across repeated tag-5 fields automatically (ord
     * concatenates them before decoding). Must be non-empty.
     */
    metadata?: Uint8Array;
    /**
     * Optional metaprotocol identifier (tag 0x07). Emitted as UTF-8
     * bytes (e.g. `'brc-20'`).
     */
    metaprotocol?: string;
    /**
     * Optional delegate inscription id (`<txid>i<index>`, tag 0x0b).
     * A delegate inscription typically carries an EMPTY body and points
     * at another inscription's content; ord serves the delegate's
     * content in its place. Unlike `parent`, this is functional with no
     * extra tx topology: the delegate link resolves purely from the
     * envelope tag. A body alongside a delegate is allowed (ord ignores
     * it when the delegate resolves) but the canonical shape is an
     * empty body.
     */
    delegate?: string;
    /**
     * Optional rune-name commitment (tag 0x0d) as the rune's u128 value.
     * Emitted as minimal little-endian bytes. The etching transaction
     * must later spend this inscription's UTXO. A pre-computed byte
     * value can go through `envelopeFields` instead.
     */
    rune?: bigint;
    /**
     * Optional CBOR properties (tag 0x11): gallery items + attributes.
     * Same contract as `metadata`: pass ALREADY-CBOR-ENCODED bytes
     * (`encodeCborDeterministic`), chunked automatically over 520 bytes.
     *
     * ord's properties struct is INTEGER-keyed. Build the CBOR with a
     * `Map` whose keys are real numbers (`new Map([[0, gallery], [1,
     * attrs]])`), NOT a plain object `{0: …, 1: …}` (whose keys are the
     * strings `"0"`/`"1"`); ord drops a text-keyed properties map. See
     * `encodeCborDeterministic`'s doc for the full caveat.
     */
    properties?: Uint8Array;
    /**
     * Optional properties-encoding hint (tag 0x13). When `'br'`, signals
     * that the `properties` bytes are brotli-compressed. Only emitted
     * alongside `properties`.
     */
    propertyEncoding?: 'br';
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
 * Args for {@link createChildInscribeTransactions}. Same content +
 * funding shape as a normal inscribe, plus the parent to spend. The
 * base `parent` string tag is replaced by an explicit pair: the
 * `parentInscriptionId` (the `parent` tag value) and the `parentUtxo`
 * (the UTXO the reveal spends + where it returns).
 */
interface CreateChildInscribeTransactionsArgs extends Omit<CreateInscribeTransactionsArgs, 'parent'> {
    /**
     * The parent inscription id (`<txid>i<index>`) — emitted as the
     * `parent` tag (0x03). This is the inscription's IDENTITY, which may
     * differ from `parentUtxo`'s outpoint if the parent has been
     * transferred since it was inscribed.
     */
    parentInscriptionId: string;
    /**
     * The parent inscription's CURRENT UTXO (spent by the reveal to prove
     * control) + the address it returns to. For the in-wallet case both
     * belong to the connected wallet.
     */
    parentUtxo: ChildRevealParent;
}
interface CreateChildInscribeTransactionsResult {
    /** Unsigned commit PSBT — the wallet signs its funding input. */
    commitPsbt: Uint8Array;
    /** Commit txid (witness-independent; stable before signing). */
    commitTxid: string;
    /**
     * Child reveal PSBT. Input 0 (parent) is UNSIGNED — the wallet signs
     * it (P2TR key-path). Input 1 (commit) is already finalized with the
     * ephemeral signature. Finalize input 0 after the wallet signs.
     */
    revealPsbt: Uint8Array;
    /** Reveal txid (witness-independent). */
    revealTxid: string;
    /** Commit-tx P2TR address. */
    commitAddress: string;
    /** Fee + vsize + funding math. */
    fees: {
        commitFeeSats: number;
        revealFeeSats: number;
        totalFeeSats: number;
        commitVsize: number;
        revealVsize: number;
        combinedVsize: number;
        commitOutputValueSats: number;
        fundingRequirementSats: number;
    };
    /** Ephemeral bearer key for the commit output (see createInscribeTransactions). */
    ephemeral: {
        privKey: Uint8Array;
        pubkeyXonly: Uint8Array;
    };
    /** The parent that must be signed on the reveal, echoed for the orchestrator. */
    parent: ChildRevealParent;
}
/**
 * Build the commit + CHILD reveal pair for an ord parent/child
 * inscription. Same commit as a normal inscribe (envelope carries the
 * `parent` tag); the reveal additionally SPENDS the parent UTXO and
 * RETURNS it to the owner, which is what makes ord recognise the parent
 * link (see {@link buildChildInscribeRevealTx}). The reveal is returned
 * as a PSBT because its parent input needs the wallet's signature.
 */
declare function createChildInscribeTransactions(args: CreateChildInscribeTransactionsArgs): CreateChildInscribeTransactionsResult;
/**
 * Turn the convenience args (pointer, metadata, metaprotocol, parent,
 * delegate, rune, note, contentEncoding, properties, propertyEncoding)
 * into ord envelope fields in the exact byte form ord expects. Each
 * value is validated here; large CBOR payloads (metadata / properties)
 * are chunked across repeated same-tag fields so no single push
 * exceeds the 520-byte cap. Field ORDER doesn't affect the resolved
 * inscription (ord indexes by tag), but a stable order keeps the
 * encoded envelope diff-friendly.
 */
declare function synthesizeEnvelopeFields(args: CreateInscribeTransactionsArgs): OrdEnvelopeField[];

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
    /** Optional Tag::Note (0x0f) watermark string. */
    note?: string;
    /**
     * Optional parent inscription id (`<txid>i<index>`); emits Tag::Parent
     * (0x03). Annotation only — full parent/child provenance also
     * requires spending the parent's UTXO in the reveal (not modelled
     * here). See `createInscribeTransactions` for the caveat.
     */
    parent?: string;
    /**
     * Optional body-encoding hint ('gzip', or 'br' for a caller-supplied
     * brotli body). Body must already be compressed; this flag only emits
     * the envelope tag.
     */
    contentEncoding?: InscriptionContentEncoding;
    /**
     * Optional pointer (tag 0x02) sat offset. Must be < 546 given this
     * builder's single-output reveal topology. See
     * `createInscribeTransactions` for the full caveat.
     */
    pointer?: number;
    /**
     * Optional CBOR metadata (tag 0x05). Pass pre-encoded bytes
     * (`encodeCborDeterministic`); chunked automatically over 520 bytes.
     */
    metadata?: Uint8Array;
    /** Optional metaprotocol identifier (tag 0x07), emitted as UTF-8. */
    metaprotocol?: string;
    /**
     * Optional delegate inscription id (`<txid>i<index>`, tag 0x0b).
     * Functional (no extra tx topology): ord serves the delegate's
     * content. Canonical shape is an empty `body`.
     */
    delegate?: string;
    /**
     * Optional rune-name commitment (tag 0x0d) as the rune's u128 value,
     * emitted as minimal little-endian bytes.
     */
    rune?: bigint;
    /**
     * Optional CBOR properties (tag 0x11): gallery + attributes. Pass
     * pre-encoded bytes (`encodeCborDeterministic`); chunked over 520.
     */
    properties?: Uint8Array;
    /** Optional properties-encoding hint (tag 0x13); only with `properties`. */
    propertyEncoding?: 'br';
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
 * Public orchestrator for the ord parent/child (provenance) inscribe.
 * Composes builder + signer + broadcast for Path 2/3:
 *
 *   1. `createChildInscribeTransactions` — commit PSBT + a CHILD reveal
 *      PSBT (parent input unsigned, commit input ephemeral-finalized).
 *   2. `signSingleFundingInput` — the wallet signs the commit's funding
 *      input; broadcast the commit.
 *   3. `signChildRevealParentInputs` — the wallet signs the reveal's
 *      PARENT input (index 0, the ordinals key that owns the parent);
 *      the commit input (index 1) is already witnessed; broadcast.
 *
 * The parent inscription is spent (proving control) and returned to the
 * wallet, and the child is created with the `parent` tag — which is what
 * makes ord recognise the provenance link. See
 * `inscription-child-reveal.helper.ts` for the topology + safety.
 */
interface InscribeChildAndBroadcastArgs {
    paymentOutput: TxnOutput;
    paymentPublicKey: Uint8Array;
    paymentAddress: string;
    /** Where the CHILD inscription lands. */
    recipientAddress: string;
    body: Uint8Array;
    contentType?: string;
    envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
    feeRatePerVbyte: number;
    walletType: KnownOrdinalWalletType;
    tip?: {
        address: string;
        value: number;
    };
    note?: string;
    contentEncoding?: InscriptionContentEncoding;
    pointer?: number;
    metadata?: Uint8Array;
    metaprotocol?: string;
    delegate?: string;
    rune?: bigint;
    properties?: Uint8Array;
    propertyEncoding?: 'br';
    /** The parent inscription id (`<txid>i<index>`) — the `parent` tag. */
    parentInscriptionId: string;
    /**
     * The parent inscription's CURRENT UTXO (spent by the reveal) + where it
     * returns. For the in-wallet case both belong to the connected wallet;
     * `parentUtxo.returnAddress` is the ordinals address the wallet signs at.
     */
    parentUtxo: ChildRevealParent;
    network: Network;
    broadcast(txHex: string): Observable<string>;
    /** Fired with the wallet-signed commit hex before broadcast. */
    onCommitSigned?(signedCommitHex: string): void;
    promptForSignedPsbt?(unsigned: {
        base64: string;
        hex: string;
    }): Observable<string>;
}
interface InscribeChildAndBroadcastResult {
    commitTxId: string;
    revealTxId: string;
    /** The child's inscription id (`<revealTxId>i0`). */
    childInscriptionId: string;
    commitAddress: string;
    /** Ephemeral bearer key — persist or forfeit reveal-side flexibility. */
    ephemeral: CreateChildInscribeTransactionsResult['ephemeral'];
    fees: CreateChildInscribeTransactionsResult['fees'];
}
declare function inscribeChildAndBroadcast(args: InscribeChildAndBroadcastArgs): Observable<InscribeChildAndBroadcastResult>;

/**
 * The per-mint payload the consumer wires into the orchestrator via
 * `setContent`. `body` and `contentType` land in the inscription
 * envelope; `tip` becomes the reveal's vout[1] output; the rest are
 * optional ord envelope tags. Recipient is optional — when unset the
 * inscription lands on the connected wallet's ordinals address.
 */
interface InscribeContent {
    body: Uint8Array;
    contentType?: string;
    envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
    /** Optional reveal vout[1] tip. Cubes-frontend pins its donation address here. */
    tip?: {
        address: string;
        value: number;
    };
    note?: string;
    parent?: string;
    contentEncoding?: InscriptionContentEncoding;
    /** Pointer (tag 0x02) sat offset; must be < 546. See createInscribeTransactions. */
    pointer?: number;
    /** CBOR metadata (tag 0x05), pre-encoded via encodeCborDeterministic; chunked over 520. */
    metadata?: Uint8Array;
    /** Metaprotocol identifier (tag 0x07), UTF-8. */
    metaprotocol?: string;
    /** Delegate inscription id (tag 0x0b); ord serves the delegate's content. */
    delegate?: string;
    /** Rune-name commitment (tag 0x0d) as the rune's u128 value. */
    rune?: bigint;
    /** CBOR properties (tag 0x11), pre-encoded; chunked over 520. */
    properties?: Uint8Array;
    /** Properties-encoding hint (tag 0x13); only alongside properties. */
    propertyEncoding?: 'br';
    /** Override for the inscription's recipient. Defaults to wallet.ordinalsAddress. */
    recipient?: string;
}
/**
 * One row in the orchestrator's `simulations$` stream. Same shape
 * as the cat21 sibling but with the inscribe-specific fee result:
 * - `insufficient: true` — UTXO can't cover
 *   `commitOutputValueSats + commitFeeSats` at the current rate.
 * - `insufficient: false` — UTXO is viable; `simulation` carries the
 *   commit + reveal vsize / fee breakdown for the "this is what'll
 *   happen" panel.
 */
interface InscribeUtxoSimulation {
    utxo: TxnOutput;
    simulation: SimulateInscribeFeesResult | null;
    insufficient: boolean;
}
/**
 * State machine the consumer's template branches on. Same six-state
 * shape as the cat21 mint orchestrator.
 */
type InscribeMintState = 'idle' | 'loading-utxos' | 'ready' | 'minting' | 'success' | 'error';
/**
 * High-level inscribe flow. Wraps `Cat21Service` (UTXOs, broadcast) +
 * `WalletService` (connected wallet) + the pure `simulateInscribeFees`
 * / `inscribeAndBroadcast` helpers into one cohesive surface, so
 * consumers drive the same state machine + reactive pipelines with
 * thin templates. Sibling of `Cat21MintOrchestrator`.
 *
 * Singleton (`providedIn: 'root'`) — state persists across route
 * navigations within a session. Auto-resets `feeRate`, `selectedUtxo`,
 * `content`, and the success/error fields when the connected wallet
 * changes (old UTXO is gone; the user picks fresh for the new wallet).
 *
 * # Two-tx model
 *
 * Every inscribe produces a commit + reveal pair. Simulations show
 * the sum of both fees + the funding requirement. `mint()` calls
 * `inscribeAndBroadcast` which signs commit via the wallet, broadcasts
 * both txs sequentially via `Cat21Service.postTransaction`, and returns
 * the pair of txids + the ephemeral bearer key.
 *
 * # Bearer key
 *
 * The ephemeral private key that controls the commit output is
 * returned in `successResult().ephemeral`. Between commit broadcast
 * and reveal broadcast (a few seconds) losing this key means the
 * commit output is unrecoverable. The orchestrator does not persist
 * it — that is a consumer concern.
 */
declare class InscribeMintOrchestrator {
    private wallet;
    private cat21;
    private network;
    /** sat/vB the user picked (from the fee picker or manually). null until set. */
    readonly feeRate: _angular_core.WritableSignal<number>;
    /** Which UTXO from the list the user picked (consumers wire auto-select). */
    readonly selectedUtxo: _angular_core.WritableSignal<TxnOutput>;
    /** The inscription payload. Simulations only fire when this is set. */
    readonly content: _angular_core.WritableSignal<InscribeContent>;
    private lastWalletAddress;
    private readonly feeRateSubject;
    private readonly contentSubject;
    readonly state: _angular_core.WritableSignal<InscribeMintState>;
    readonly errorMessage: _angular_core.WritableSignal<string>;
    readonly successResult: _angular_core.WritableSignal<InscribeAndBroadcastResult>;
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
     * For each UTXO + current fee rate + set content, run
     * `simulateInscribeFees` to produce the commit + reveal fee
     * breakdown. UTXOs that can't cover `fundingRequirementSats` come
     * through with `insufficient: true` rather than poisoning the whole
     * stream.
     *
     * Re-emits whenever utxos$, wallet, feeRate, or content changes.
     * Emits `[]` when content is null (consumer hasn't wired the
     * inscription payload yet).
     */
    readonly simulations$: Observable<InscribeUtxoSimulation[]>;
    /** Pass-through of the SDK's polled fee tiers. */
    readonly recommendedFees$: Observable<RecommendedFees>;
    constructor();
    private readonly walletChangeSub;
    setFeeRate(rate: number): void;
    setSelectedUtxo(utxo: TxnOutput | null): void;
    setContent(content: InscribeContent | null): void;
    /**
     * Trigger the inscribe. Requires a connected wallet, a feeRate set,
     * a selectedUtxo, and content set. Composes:
     *   1. `simulateInscribeFees` for the picked UTXO to derive the
     *      exact commit / reveal fee at broadcast time.
     *   2. `inscribeAndBroadcast` — signs the commit input via the
     *      wallet, broadcasts commit, signs reveal internally,
     *      broadcasts reveal — via `Cat21Service.postTransaction`.
     *
     * Transitions state to `minting` → `success` (with `successResult`)
     * or `error` (with `errorMessage`).
     */
    mint(): Observable<InscribeAndBroadcastResult>;
    /**
     * Wipe form state back to a fresh mint (typically the "Mint another"
     * button on the success screen). Keeps the wallet connected.
     */
    reset(): void;
    private resetFormState;
    private computeSimulations;
    static ɵfac: _angular_core.ɵɵFactoryDeclaration<InscribeMintOrchestrator, never>;
    static ɵprov: _angular_core.ɵɵInjectableDeclaration<InscribeMintOrchestrator>;
}

/**
 * Bulletproof gate types for the inscribe operation.
 *
 * Single entry point: `validateInscribeOperation({ config, operation })`
 * returns a discriminated `{ ok: true, resources } | { ok: false,
 * reason, detail? }`. Same shape as `validateCat21Operation` in
 * `cat21-validation/`, but a SEPARATE module by deliberate design:
 *
 *   - Inscribing an ord envelope (`<pubkey> CHECKSIG OP_FALSE OP_IF
 *     "ord" <tags> body OP_ENDIF`, lockTime=0) is a different
 *     on-chain-data protocol from CAT-21 (`nLockTime=21`, no
 *     envelope, no on-chain content). The validation surfaces stay
 *     separate so consumers can't accidentally mix them.
 *   - Inscribe consumers (cat21.space's future inscribe UI, a
 *     potential `ordpool-inscriber` tool) configure inscribe rules
 *     here. Cat21 consumers (cat21-wallet, cat21.space's mint flows)
 *     configure cat21 rules in `cat21-validation/`.
 *
 * Address / fee-rate validation primitives are duplicated rather
 * than shared with `cat21-validation/` so each gate's rejection-
 * reason union stays minimal and operation-named. If a third
 * Bitcoin operation lands and the same primitives surface for a
 * third time, extract them into a shared `bitcoin-validation/`
 * module at that point — YAGNI for now.
 *
 * Design rules:
 *   - Each rejection reason is one test case. No catch-all
 *     `'invalid-intent'` reasons.
 *   - The `resources` field on success carries pre-decoded values
 *     so the downstream builder doesn't re-decode.
 *   - Config is wholly optional except for `network`.
 */

/**
 * Intent shape for an ord-protocol inscription. The user/agent
 * declares the body bytes + content type + recipient + fee rate;
 * the SDK builds commit + reveal via `createInscribeTransactions`.
 *
 * NOT a cat21 operation. The wire-format outcome is two regular
 * Bitcoin txs (lockTime=0) carrying an ord envelope in the reveal
 * tx's witness — no `nLockTime=21`, no CAT-21 cat produced.
 */
interface InscribeIntent {
    /** Where the inscription lands (P2TR recommended). */
    recipient: string;
    /** sat/vB target (applied identically to commit + reveal). */
    feeRate: number;
    /**
     * Body bytes. The cap is `maxContentBytes` from config (default
     * 350_000 — keeps the reveal under standard relay).
     */
    body: Uint8Array;
    /**
     * MIME type embedded in the envelope. The gate enforces the
     * `allowedContentTypes` allowlist (when configured) and the
     * `blockedContentTypes` blocklist defensive filter.
     */
    contentType?: string;
    /**
     * Optional reveal-tx tip output. The gate validates the address on
     * the configured network and the value against the dust floor +
     * `maxTipValueSats` cap. Zero is treated as "no tip".
     *
     * The most policy-sensitive optional — an autonomous agent path
     * without a cap could drain a wallet by inflating `tip.value`.
     */
    tip?: {
        address: string;
        value: number;
    };
    /** Optional Tag::Note (0x0f) UTF-8 watermark; capped at `maxNoteBytes`. */
    note?: string;
    /** Optional parent inscription id (`<txid>i<index>`). */
    parent?: string;
    /** Optional body-encoding hint (`'gzip'` or `'br'` if present). */
    contentEncoding?: InscriptionContentEncoding;
}
/**
 * Discriminated union over the inscribe-side operations the gate
 * validates. One variant today (`'inscribe'`); the shape is a
 * discriminated union so a future variant (RBF-the-reveal, etc.)
 * can land without rewriting the caller-side dispatch.
 */
type InscribeOperation = {
    kind: 'inscribe';
    intent: InscribeIntent;
};
interface InscribeOperationGateConfig {
    /** Active network. Address checks key off this. */
    network: Network;
    /**
     * Hard ceiling on fee rate. Recommend 1000 sat/vB as a "you typed
     * something wrong" backstop. When unset, only `feeRate > 0` is
     * enforced.
     */
    maxFeeRatePerVbyte?: number;
    /**
     * Wallet's own payment address. When provided, the gate rejects
     * an inscription whose recipient matches it (self-send guard).
     */
    ownPaymentAddress?: string;
    /**
     * Positive recipient allowlist. When set and non-empty, the
     * recipient MUST be in the list.
     */
    allowedRecipients?: ReadonlyArray<string>;
    /**
     * Maximum inscription body size in bytes. Default 350_000.
     * Larger bodies are a Phase-3 Slipstream concern.
     */
    maxContentBytes?: number;
    /**
     * Positive content-type allowlist (exact case-insensitive match).
     * When unset/empty → any well-formed contentType permitted.
     *
     * Recommended day-one allowlist: image/png, image/jpeg,
     * image/svg+xml, image/webp, image/gif, text/plain, text/html,
     * application/json, application/cbor.
     */
    allowedContentTypes?: ReadonlyArray<string>;
    /**
     * Defensive content-type blocklist. Wins over the allowlist
     * (defence in depth against a misconfigured allowlist).
     *
     * Recommended day-one blocklist: 'application/javascript',
     * 'text/javascript', 'application/x-javascript' (XSS-flavoured
     * inscribers).
     */
    blockedContentTypes?: ReadonlyArray<string>;
    /**
     * Hard ceiling on `tip.value` in sats. Recommended for autonomous
     * flows (drain protection). When unset, only the dust-floor + integer
     * checks apply.
     */
    maxTipValueSats?: number;
    /**
     * Positive tip-address allowlist. When set and non-empty, the tip
     * MUST go to a listed address. Practical for automated flows where
     * the tip beneficiary is fixed.
     */
    allowedTipAddresses?: ReadonlyArray<string>;
    /** Maximum note bytes (UTF-8). Default 128. */
    maxNoteBytes?: number;
}
type InscribeGateRejectReason = 'intent-not-an-object' | 'unsupported-operation-kind' | 'recipient-not-a-bitcoin-address' | 'recipient-wrong-network' | 'recipient-not-allowed' | 'self-send' | 'fee-rate-not-finite-number' | 'fee-rate-not-positive' | 'fee-rate-not-integer' | 'fee-rate-above-cap' | 'content-not-bytes' | 'content-too-large' | 'content-type-not-string' | 'content-type-not-allowed' | 'content-type-blocked' | 'tip-not-an-object' | 'tip-address-not-a-bitcoin-address' | 'tip-address-wrong-network' | 'tip-address-not-allowed' | 'tip-value-not-finite-number' | 'tip-value-not-integer' | 'tip-value-negative' | 'tip-value-below-dust' | 'tip-value-above-cap' | 'note-not-a-string' | 'note-too-large' | 'parent-malformed' | 'content-encoding-invalid';
type InscribeGateResources = {
    kind: 'inscribe';
    recipientScript: Uint8Array;
    /** Validated content bytes — same object the caller passed. */
    contentBytes: Uint8Array;
    /** Normalised contentType (lowercased) when present. */
    contentType: string | undefined;
    /**
     * Pre-decoded tip when supplied and non-zero. Downstream builders
     * pass `tipScript`/`tipValueSats` straight into the reveal builder
     * without re-decoding the address.
     */
    tip?: {
        address: string;
        tipScript: Uint8Array;
        tipValueSats: number;
    };
    /** Validated + length-checked note UTF-8 bytes, when supplied. */
    noteBytes?: Uint8Array;
    /** Pre-encoded parent tag value (reversed txid + LE-trimmed index), when supplied. */
    parentBytes?: Uint8Array;
    /** Validated content encoding when supplied (`'gzip'` or `'br'`). */
    contentEncoding?: InscriptionContentEncoding;
};
type InscribeOperationGateResult = {
    ok: true;
    resources: InscribeGateResources;
} | {
    ok: false;
    reason: InscribeGateRejectReason;
    detail?: string;
};

/**
 * Inscribe operation validation gate. Parallel to
 * `validateCat21Operation` from `cat21-validation/`, separate by
 * design (different protocol, different consumer set). See the
 * types file for the full rationale.
 */

declare function validateInscribeOperation(args: {
    config: InscribeOperationGateConfig;
    operation: InscribeOperation;
}): InscribeOperationGateResult;

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
type AgentActionKind = 'cat21_mint' | 'cat21_transfer' | 'cat21_create_offer' | 'cat21_accept_offer' | 'cat21_buy';
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
type AgentPolicyDenyReason = 'agent-disabled' | 'spend-above-action-cap' | 'spend-above-daily-cap' | 'fee-rate-above-ceiling' | 'price-below-floor' | 'counterparty-not-allowed' | 'malformed-numeric-field';

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

export { AUTO_SCAN_MAX_VALUE_SAT, CAT21_LISTING_MESSAGE_VERSION, CAT21_LOCK_TIME, CAT21_OFFER_POSTAGE_SATS, CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE, CAT21_POSTAGE_SATS, CAT21_QUERY_KEYS, CAT21_SESSION_MAX_VALIDITY_MS, CAT21_SESSION_VALIDITY_MS, CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS, CAT21_TRANSFER_POSTAGE_SATS, CAT21_WALLET_INPUT_SEQUENCE, Cat21AcceptOfferOrchestrator, Cat21ApiService, Cat21CreateOfferOrchestrator, Cat21MintOrchestrator, Cat21Service, Cat21TransferOrchestrator, DEFAULT_INSCRIBE_BROADCAST_ENDPOINTS, INSCRIBE_POSTAGE_SATS, INSCRIPTION_CONTENT_ENCODINGS, InscribeMintOrchestrator, KnownOrdinalWalletType, KnownOrdinalWallets, LAST_CONNECTED_WALLET, MAX_ASK_SATS, MAX_BUY_OFFER_PSBT_BYTES, Network, ORD_TAGS, RARE_SAT_MAX_RANGES, SLIPSTREAM_BODY_TX_FIELD, SLIPSTREAM_DEFAULT_BASE_URL, SLIPSTREAM_SUBMIT_PATH, SMALL_UTXO_WARNING_THRESHOLD_SAT, STANDARD_TX_WEIGHT_LIMIT, UtxoContentScanner, WalletService, addCat21Input, addressesEquivalent, allowlistContainsAddress, assertCat21LockTime, assessCompression, bitcoinNetwork, broadcastCat21, broadcastInscribePackage, bucketOf, buildAcceptOfferQueryParams, buildAskQueryParams, buildBuyOfferQueryParams, buildCat21BuyOfferPsbt, buildCat21SessionMessage, buildCat21TransferPsbt, buildChildInscribeRevealTx, buildInputScript, buildInscribeCommitPsbt, buildInscribeRevealTx, buildInscriptionEnvelope, buildListingMessage, buildTransferQueryParams, calculateRecommendedFundingSats, cat21Config, checkSessionValidity, chunkFieldValue, compressGzip, createChildInscribeTransactions, createInscribeTransactions, createTransaction, decideBroadcastChannel, decompressGzip, deriveRevealPubkeyXonly, eitherAsString, encodeCborDeterministic, encodeInscriptionId, encodeParentInscriptionId, encodePointerValue, encodeRuneCommitment, evaluateAgentPolicy, findAutoPickCandidate, findRareSatInRange, findRareSatInRanges, getAddressFormat, getAddressNetwork, getDummyKeypair, getDummyLegacyTransaction, getMinimumUtxoSize, inscribeAndBroadcast, inscribeChildAndBroadcast, isAddressCompatibleWithNetwork, isInscribeSupportedPaymentAddress, isScanComplete, isSegWit, isValidPersistedWalletInfo, leatherOrdinalsAddressType, leatherPaymentAddressType, listFundingUtxosThatCover, locateSat, nativeBrotliAvailable, parseAcceptOfferQueryParams, parseAskQueryParams, parseBuyOfferQueryParams, parseCatsList, parseTransferQueryParams, pickLargestFundingUtxoThatCovers, pickSmallestFundingUtxoThatCovers, prepareBuyOfferBuyerInput, prepareCat21Input, prepareInscribeFundingInput, prepareMintInputForWallet, prepareTransferCatInput, prepareTransferFundingInput, rarityOfBlockFirstSat, rarityOfSat, resolveCat21MintInputSequence, runeNamesFromContent, serializeCats, simulateInscribeFees, storage, submitToSlipstream, synthesizeEnvelopeFields, toBitcoinNetworkType, toLeatherNetworkString, toOrdinalsAddress, toPaymentAddress, toScureNetwork, toXOnly, twoPassFeeSimulation, validateCat21BuyOfferPsbt, validateInscribeOperation, verifyBip322Signature, verifyListingSignature };
export type { AcceptOfferQueryArgs, AcceptOfferState, AddressNetworkGroup, AgentActionContext, AgentActionKind, AgentPolicy, AgentPolicyDecision, AgentPolicyDenyReason, AskQueryArgs, AssessCompressionOptions, BuildCat21BuyOfferArgs, BuildCat21BuyOfferResult, BuildCat21TransferArgs, BuildCat21TransferResult, BuildInputScriptArgs, BuildInputScriptResult, BuildInscriptionEnvelopeArgs, BuyOfferQueryArgs, BuyOfferTargetCat, Cat21, Cat21BroadcastChannel, Cat21BroadcastDecision, Cat21BroadcastInput, Cat21BroadcastOptions, Cat21BroadcastResult, Cat21Holding, Cat21Listing, Cat21OfferBuyerInput, Cat21OfferDestinations, Cat21OfferRejectionReason, Cat21OfferSellerInput, Cat21OfferValidation, Cat21OfferValidationFailure, Cat21OfferValidationResult, Cat21OrdOutputResponse, Cat21PaginatedResult, Cat21PreparedInput, Cat21SdkConfig, Cat21SingleResult, Cat21TransferCatInput, Cat21TransferDestinations, Cat21TransferFundingInput, CatNumbersResult, CatOutpoint, ChildInscribeRevealArgs, ChildInscribeRevealResult, ChildRevealParent, CompressionAssessment, CreateChildInscribeTransactionsArgs, CreateChildInscribeTransactionsResult, CreateInscribeTransactionsArgs, CreateInscribeTransactionsResult, CreateOfferSimulation, CreateOfferSimulationOutcome, CreateOfferState, CreateTransactionResult, DummyKeypairResult, ErrorResponse, FundingUtxo, InscribeAndBroadcastArgs, InscribeAndBroadcastResult, InscribeChildAndBroadcastArgs, InscribeChildAndBroadcastResult, InscribeCommitArgs, InscribeCommitResult, InscribeContent, InscribeFundingInput, InscribeGateRejectReason, InscribeGateResources, InscribeIntent, InscribeMintState, InscribeOperation, InscribeOperationGateConfig, InscribeOperationGateResult, InscribePackageBroadcastInput, InscribePackageBroadcastOptions, InscribePackageBroadcastResult, InscribePackageEndpointResult, InscribeRevealArgs, InscribeRevealResult, InscribeUtxoSimulation, InscriptionContentEncoding, KnownOrdinalWallet, LeatherAddress, LeatherAddressResponse, LeatherBtcAddress, LeatherPSBTBroadcastResponse, LeatherSignPsbtRequestParams, LeatherStxAddress, ListingMessageFields, MempoolTx, MintState, OrdEnvelopeField, OrdOutputResponse, OrdTag, OrdinalsAddress, ParsedAskQuery, ParsedBuyOfferQuery, ParsedOffer, PaymentAddress, PendingMint, PickFundingUtxoArgs, PrepareBuyOfferBuyerInputArgs, PrepareCat21InputArgs, PrepareInscribeFundingInputArgs, PrepareTransferInputArgs, RecommendedFees, SatRarity, SignMessageArgs, SignMessageResult, SimulateInscribeFeesArgs, SimulateInscribeFeesResult, SimulateTransactionResult, SlipstreamSubmitResponse, StatusResult, StorageLike, SubmitToSlipstreamOptions, TransferQueryArgs, TransferSimulation, TransferSimulationOutcome, TransferState, TwoPassFeeSimulationArgs, TwoPassFeeSimulationResult, TxnOutput, TxnOutputStatus, UtxoContent, UtxoScanBucket, UtxoScanState, UtxoSimulation, ValidateCat21BuyOfferArgs, VerifyBip322RejectionReason, VerifyBip322SignatureResult, VerifyListingRejectionReason, VerifyListingSignatureResult, WalletConnector, WalletInfo, WindowLike, XverseAddressResponse };
