import { KnownOrdinalWalletType, KnownOrdinalWallets } from './wallet.service.types';

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
    label: KnownOrdinalWallets[KnownOrdinalWalletType.cat21wallet].label,
    platforms: [WalletPlatform.Desktop],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Proven },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Proven },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Proven },
    },
    note: 'Our own wallet (Leather fork). Full regtest coverage across every operation.',
  },
  {
    wallet: KnownOrdinalWalletType.xverse,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.xverse].label,
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
    note: 'On mobile, open this site inside the Xverse in-app browser (not the default mobile browser).',
  },
  {
    wallet: KnownOrdinalWalletType.leather,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.leather].label,
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
    note: 'Desktop extension only. Ordinals and BRC-20 are supported; the Leather mobile app does not work with this site.',
  },
  {
    wallet: KnownOrdinalWalletType.unisat,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.unisat].label,
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
    note: 'Desktop extension only. The UniSat mobile app is not supported here.',
  },
  {
    wallet: KnownOrdinalWalletType.wizz,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.wizz].label,
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
    note: 'Desktop extension only.',
  },
  {
    wallet: KnownOrdinalWalletType.okx,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.okx].label,
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
        caveat: 'Collections use three approvals in a row on OKX and can occasionally not complete the first time; if that happens, just try again.',
      },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Adapter },
    },
    note: 'Signs with your Taproot (bc1p) account. Supports mint, send, buy and sell, and inscribe. Works in the desktop extension and in the OKX mobile app browser.',
  },
  {
    wallet: KnownOrdinalWalletType.phantom,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.phantom].label,
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
    note: 'Phantom\'s Bitcoin wallet is only available in the Phantom mobile app browser, not the desktop extension.',
  },
  {
    wallet: KnownOrdinalWalletType.alby,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.alby].label,
    platforms: [WalletPlatform.Desktop],
    signingMode: 'injected',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: {
        support: CapabilitySupport.Unsupported,
        caveat: "Alby cannot transfer: its API exposes no per-input signing, so it cannot sign a transfer's cat input plus the funding inputs. Single-input flows (mint, plain inscription) work.",
      },
      [WalletCapability.Cat21OfferCreate]: {
        support: CapabilitySupport.Unsupported,
        caveat: 'Alby cannot create offers: it signs every input in a transaction with your one key, so it cannot co-sign an offer alongside the buyer.',
      },
      [WalletCapability.Cat21OfferAccept]: {
        support: CapabilitySupport.Unsupported,
        caveat: 'Alby cannot accept offers: it signs every input with your one key, so it cannot co-sign the trade with the seller.',
      },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: {
        support: CapabilitySupport.Unsupported,
        caveat: 'Alby cannot build collections: it signs every input with your one key, so it cannot leave the helper input unsigned. Plain inscriptions work.',
      },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    note: 'Signs on-chain with your Alby account key (no Alby Hub needed). Every input it signs must come from your Taproot (bc1p) account. Any address type can hold a cat. No mobile browser support.',
  },
  {
    wallet: KnownOrdinalWalletType.binance,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.binance].label,
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
    note: 'Bitcoin support is in the Binance Web3 Wallet mobile app browser. The browser extension does not expose a Bitcoin wallet.',
  },
  {
    wallet: KnownOrdinalWalletType.xpub,
    label: KnownOrdinalWallets[KnownOrdinalWalletType.xpub].label,
    platforms: [WalletPlatform.Desktop, WalletPlatform.Mobile],
    signingMode: 'watch-only',
    capabilities: {
      [WalletCapability.Cat21Mint]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21Transfer]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferCreate]: { support: CapabilitySupport.Proven },
      [WalletCapability.Cat21OfferAccept]: { support: CapabilitySupport.Proven },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: { support: CapabilitySupport.Proven },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    note: 'Watch-only via extended public key (xpub / ypub / zpub / tpub). Builds a PSBT you sign in your own wallet (Sparrow, Coldcard, Ledger, …); nothing is signed in the browser. Paste your account key to connect; for a plain xpub, choose the Taproot account type. Works on desktop and mobile.',
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
