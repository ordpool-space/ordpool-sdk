import { KnownOrdinalWalletType } from './wallet.service.types';

/**
 * Wallet capability matrix — the single source of truth for "which wallet
 * can do what, on which platform, and how well proven".
 *
 * Consumers (ordpool.space, cat21.space, cubes.haushoppe.art) use this to
 * render a wallet picker that only offers wallets that can actually serve
 * the current user: filtered by platform (desktop extension vs mobile
 * in-app browser) and by the operation the user is about to perform
 * (mint, transfer, offer, inscription, collection child-inscribe).
 *
 * The data is curated, not auto-derived: platform availability is a
 * real-world fact about each wallet (verified against official developer
 * docs), and the support level reflects our own regtest e2e evidence.
 * See CHILD-INSCRIBE-WALLET-SUPPORT.md and the three consumer handover
 * docs for the reasoning behind each row.
 */

/** A Bitcoin operation the SDK can drive through a wallet. Maps 1:1 to an orchestrator. */
export enum WalletCapability {
  Cat21Mint = 'cat21-mint',
  Cat21Transfer = 'cat21-transfer',
  Cat21OfferCreate = 'cat21-offer-create',
  Cat21OfferAccept = 'cat21-offer-accept',
  Inscription = 'inscription',
  InscriptionParentChild = 'inscription-parent-child',
  SignMessage = 'sign-message',
}

/**
 * Where a wallet's provider is reachable BY THIS SDK.
 *
 * `Mobile` means the wallet exposes its injected provider inside its own
 * mobile in-app dApp browser (so our connect/sign path works there),
 * NOT merely that the wallet ships a mobile app. A wallet whose mobile
 * app only connects via a custom deep-link protocol (e.g. `unisat://`)
 * is NOT `Mobile` here, because the SDK's injected-provider path does not
 * work in that app.
 */
export enum WalletPlatform {
  Desktop = 'desktop',
  Mobile = 'mobile',
}

/** How well a wallet's support for a capability is established. */
export enum CapabilitySupport {
  /** A real regtest e2e roundtrip signs + broadcasts this operation, green in CI. */
  Proven = 'proven',
  /** The signer implements it and is unit-tested, but no e2e roundtrip exists yet. */
  Adapter = 'adapter',
  /** The wallet cannot do this operation (a documented wallet-side block). */
  Unsupported = 'unsupported',
}

export interface WalletCapabilityStatus {
  support: CapabilitySupport;
  /** Short, user-actionable constraint (e.g. "requires the active address type to be Taproot"). */
  caveat?: string;
}

export interface WalletMatrixEntry {
  wallet: KnownOrdinalWalletType;
  label: string;
  platforms: readonly WalletPlatform[];
  /**
   * `injected` — the wallet signs in-page via its provider.
   * `watch-only` — no signing key in the browser; the SDK builds a PSBT
   * the user signs elsewhere (Sparrow, Coldcard, Ledger, …).
   */
  signingMode: 'injected' | 'watch-only';
  /** Capabilities not listed default to {@link CapabilitySupport.Unsupported}. */
  capabilities: Partial<Record<WalletCapability, WalletCapabilityStatus>>;
  /** Wallet-level caveat spanning capabilities (address-type default, mobile entry mechanism, backend). */
  note?: string;
}

const TAPROOT_ACTIVE_ADDRESS = 'requires the wallet\'s active address type to be Taproot (P2TR)';

/**
 * The matrix. One row per wallet the SDK ships a signer for.
 *
 * Support levels are grounded in the regtest wallet-matrix e2e
 * (`e2e/playwright/specs/*`): an operation is `Proven` only where a real
 * extension signs it green in CI. Everything the signer implements but no
 * e2e exercises is `Adapter`. Platform values are verified against each
 * wallet's official developer docs.
 */
export const WALLET_MATRIX: readonly WalletMatrixEntry[] = [
  {
    wallet: KnownOrdinalWalletType.cat21wallet,
    label: 'Cat21 Wallet',
    platforms: [WalletPlatform.Desktop],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Proven },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Proven },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Adapter },
    },
    note: 'Our own wallet (Leather fork). Full regtest coverage across every operation.',
  },
  {
    wallet: KnownOrdinalWalletType.xverse,
    label: 'Xverse',
    platforms: [WalletPlatform.Desktop, WalletPlatform.Mobile],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Proven },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Proven },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Adapter },
    },
    note: 'Mobile support means inside the Xverse in-app browser (deep-link via connect.xverse.app/browser?url=), where the same sats-connect provider is injected; not the default mobile browser.',
  },
  {
    wallet: KnownOrdinalWalletType.leather,
    label: 'Leather',
    platforms: [WalletPlatform.Desktop],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Proven },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Proven },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Adapter },
    },
    note: 'Desktop extension only. The Leather mobile app\'s in-app browser is a curated Stacks-DeFi directory and does not inject LeatherProvider for arbitrary sites. Ordinals/BRC-20 remain supported, though Leather\'s positioning has pivoted to Bitcoin DeFi/yield.',
  },
  {
    wallet: KnownOrdinalWalletType.unisat,
    label: 'UniSat',
    platforms: [WalletPlatform.Desktop],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Proven },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Proven, caveat: TAPROOT_ACTIVE_ADDRESS },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Adapter },
    },
    note: 'Desktop extension only for this SDK. The UniSat mobile app connects via the unisat:// deep-link protocol, not an injected window.unisat, so the SDK\'s provider path does not work there.',
  },
  {
    wallet: KnownOrdinalWalletType.wizz,
    label: 'Wizz',
    platforms: [WalletPlatform.Desktop],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Proven },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Proven, caveat: TAPROOT_ACTIVE_ADDRESS },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    note: 'Desktop extension only. No documented mobile in-app dApp browser that injects window.wizz.',
  },
  {
    wallet: KnownOrdinalWalletType.okx,
    label: 'OKX',
    platforms: [WalletPlatform.Desktop, WalletPlatform.Mobile],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Proven },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: {
        support: CapabilitySupport.Proven,
        caveat: 'Operation proven on regtest (both signs complete, valid child inscription); the child e2e is flaky (~2/3) from OKX extension instability on the two back-to-back signPsbt calls and is fixmed pending stabilisation.',
      },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Adapter },
    },
    note: 'OKX is single-address BIP-86 Taproot. Every cat21 operation (mint, transfer, offer create/accept, inscribe, and parent/child inscribe) is proven on the regtest e2e via the mainnet-address shim: the P2TR script hash is HRP-independent, so OKX signs the regtest input against its mainnet account, and signPsbt resolves for the connected dApp (it auto-approves without an interactive Confirm; the offer/child flows sign only the wallet\'s own input and leave the foreign one). Mobile support is the OKX App\'s built-in dApp browser, compatible with the injected window.okxwallet provider path (Bitcoin included).',
  },
  {
    wallet: KnownOrdinalWalletType.phantom,
    label: 'Phantom',
    platforms: [WalletPlatform.Mobile],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Adapter },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Adapter },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    note: 'The desktop extension ships its Bitcoin provider dormant, so detect returns false and Phantom is hidden on desktop. Only the Phantom mobile in-app browser exposes window.phantom.bitcoin. No regtest roundtrip exists (CI runs the desktop binary), so mobile signing is adapter-level, not proven.',
  },
  {
    wallet: KnownOrdinalWalletType.alby,
    label: 'Alby',
    platforms: [WalletPlatform.Desktop],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: {
        support: CapabilitySupport.Unsupported,
        caveat: 'Alby WebBTC signPsbt signs EVERY input with one Taproot key and finalizes, so it cannot sign or skip the offer PSBT\'s foreign P2WPKH input',
      },
      [WalletCapability.Cat21OfferAccept]: {
        support: CapabilitySupport.Unsupported,
        caveat: 'Alby WebBTC signPsbt signs EVERY input with one Taproot key and finalizes, so it chokes on the buyer\'s foreign P2WPKH input',
      },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Adapter },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    note: 'On-chain via the WebBTC provider, signed with the Alby account master key (no Alby Hub needed). Ensure the account is Taproot (bc1p): Alby may default to native SegWit (bc1q), which cannot hold cats. No mobile dApp browser (Alby Go is Lightning-only).',
  },
  {
    wallet: KnownOrdinalWalletType.binance,
    label: 'Binance Web3 Wallet',
    platforms: [WalletPlatform.Mobile],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Adapter },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Adapter },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    note: 'The Bitcoin provider (window.binancew3w.bitcoin) is documented for the Binance Web3 Wallet in-app dApp browser (mobile); the browser extension is not documented to inject the Bitcoin provider. Adapter-level across the board (no regtest roundtrip).',
  },
  {
    wallet: KnownOrdinalWalletType.xpub,
    label: 'Watch-only (xpub)',
    platforms: [WalletPlatform.Desktop, WalletPlatform.Mobile],
    signingMode: 'watch-only',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Adapter },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Adapter },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Adapter },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    note: 'Watch-only via BIP-32 xpub paste. Builds a PSBT you sign in your own wallet (Sparrow, Electrum, Coldcard, Ledger, Trezor, …). Platform-agnostic; no in-page signing.',
  },
];

const SUPPORT_RANK: Record<CapabilitySupport, number> = {
  [CapabilitySupport.Unsupported]: 0,
  [CapabilitySupport.Adapter]: 1,
  [CapabilitySupport.Proven]: 2,
};

/** The matrix row for a wallet, or `undefined` if the SDK ships no signer for it. */
export function walletMatrixEntry(wallet: KnownOrdinalWalletType): WalletMatrixEntry | undefined {
  return WALLET_MATRIX.find(e => e.wallet === wallet);
}

/**
 * The wallet's support for a capability. Total function: a capability the
 * wallet does not list (or an unknown wallet) resolves to
 * {@link CapabilitySupport.Unsupported}.
 */
export function capabilityOf(
  wallet: KnownOrdinalWalletType,
  capability: WalletCapability,
): WalletCapabilityStatus {
  return walletMatrixEntry(wallet)?.capabilities[capability]
    ?? { support: CapabilitySupport.Unsupported };
}

/**
 * True if the wallet can do the capability (support is not Unsupported)
 * on the given platform (omit `platform` to ignore the platform filter).
 */
export function supportsCapability(
  wallet: KnownOrdinalWalletType,
  capability: WalletCapability,
  platform?: WalletPlatform,
): boolean {
  const entry = walletMatrixEntry(wallet);
  if (!entry) return false;
  if (platform && !entry.platforms.includes(platform)) return false;
  const status = entry.capabilities[capability];
  return !!status && status.support !== CapabilitySupport.Unsupported;
}

/**
 * Every wallet a consumer should offer for a capability, in matrix order.
 *
 * @param capability the operation the user is about to perform.
 * @param opts.platform restrict to wallets reachable on this platform.
 * @param opts.minSupport lowest support level to include (default
 *   `Adapter`: everything the SDK implements; pass `Proven` for
 *   regtest-verified only).
 */
export function walletsSupporting(
  capability: WalletCapability,
  opts: { platform?: WalletPlatform; minSupport?: CapabilitySupport } = {},
): WalletMatrixEntry[] {
  const floor = SUPPORT_RANK[opts.minSupport ?? CapabilitySupport.Adapter];
  return WALLET_MATRIX.filter(entry => {
    if (opts.platform && !entry.platforms.includes(opts.platform)) return false;
    const status = entry.capabilities[capability];
    return !!status && SUPPORT_RANK[status.support] >= floor;
  });
}

/** Every wallet reachable on a platform, in matrix order. */
export function walletsForPlatform(platform: WalletPlatform): WalletMatrixEntry[] {
  return WALLET_MATRIX.filter(e => e.platforms.includes(platform));
}
