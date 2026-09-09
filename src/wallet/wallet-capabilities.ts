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
  /**
   * The one thing the user has to know about this wallet and this action,
   * written to be printed verbatim: a complete sentence, second person,
   * ending in a full stop. A consumer never composes or reworders it.
   *
   * On an `Unsupported` capability it says plainly that the wallet cannot
   * do it and why, in terms of what the wallet does to a transaction,
   * not in terms of our API names. On a `Proven` capability it is the
   * step the user must take first.
   *
   * It never names the wallets to use instead: that list changes as the
   * matrix changes, so it is computed from the matrix at render time.
   */
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
  /**
   * What this wallet does with a cat once it HOLDS one, when that is
   * something the owner has to know.
   *
   * Separate from {@link capabilities} on purpose: those answer "can this
   * wallet perform the operation", which a wallet can do perfectly while
   * still putting the resulting cat at risk. A wallet that keeps
   * ordinals and spendable coins on one address can later pay a fee with
   * the sat a cat lives on, and no capability level expresses that.
   *
   * Surface it wherever the connected wallet ENDS UP HOLDING a cat.
   * Follow the cat, not the verb:
   *
   *   `Cat21Mint`         cat arrives   -> show it
   *   `Cat21OfferCreate`  YOU are the buyer; the cat lands with you when
   *                       the seller accepts, and this is the moment you
   *                       choose which wallet receives it  -> show it
   *   `Cat21OfferAccept`  YOU are the SELLER; the cat leaves  -> do not
   *   `Cat21Transfer`     you are sending; the cat leaves     -> do not
   *
   * The accept/create pair is the trap: "accepting an offer" sounds like
   * acquiring and is the opposite, because the offer is a BUY-offer and
   * the seller is the one who accepts it.
   *
   * Describe the mechanism, never a verdict: "keeps them on one address"
   * is checkable, "is unsafe" is a judgement about someone else's
   * product that rots the moment they change it.
   */
  custodyCaveat?: string;
  /**
   * Wallet-level caveat spanning capabilities (address-type default,
   * mobile entry mechanism, backend), written for the person choosing a
   * wallet. It answers "what do I have to know or do differently with
   * this one" and nothing else.
   *
   * Never state how well WE tested it. Our coverage, our CI, our fork
   * lineage and our internal tooling names are not facts a user can act
   * on; software working is the baseline, not a selling point. The
   * engineering signal lives in {@link CapabilitySupport}, which stays
   * inside the SDK and decides which wallets we offer, and it never
   * becomes a sentence anybody reads.
   */
  note?: string;
}

const TAPROOT_ACTIVE_ADDRESS =
  'Switch your wallet to its Taproot (bc1p…) address, then connect again.';

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
    note: 'The wallet for your CAT-21 cats: mint, send and trade them, and it never spends a cat by accident.',
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
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Proven },
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
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Proven },
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
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Proven, caveat: TAPROOT_ACTIVE_ADDRESS },
    },
    custodyCaveat: 'UniSat keeps your cats and your spendable coins on one address, so it can spend the sat a cat lives on when it pays a fee. Move a cat you want to keep to a wallet that holds ordinals separately.',
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
        caveat: 'OKX asks you to approve three times in a row here, and sometimes drops out partway. Start over and it goes through.',
      },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Proven },
    },
    note: 'Signs with your Taproot (bc1p) account. Works in the desktop extension and in the OKX mobile app browser.',
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
        caveat: 'Alby cannot send a cat. It signs a transaction all at once, and sending needs the cat and the sats you pay with signed separately.',
      },
      [WalletCapability.Cat21OfferCreate]: {
        support: CapabilitySupport.Unsupported,
        caveat: 'Alby cannot sell a cat. Selling means signing your half and leaving the buyer\'s half open, and Alby signs everything at once.',
      },
      [WalletCapability.Cat21OfferAccept]: {
        support: CapabilitySupport.Unsupported,
        caveat: 'Alby cannot buy a cat. Buying means signing your half of a deal the seller already signed, and Alby signs everything at once.',
      },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: {
        support: CapabilitySupport.Unsupported,
        caveat: 'Alby cannot add to a collection. That needs one part of the transaction left unsigned, and Alby signs everything at once. Single inscriptions work.',
      },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    note: 'Signs with your Alby account key. The sats it spends must sit on your Taproot (bc1p) account.',
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
    note: 'Paste your account key (xpub / ypub / zpub / tpub) to connect. Nothing is signed here: you get a file to sign in Sparrow, Coldcard, Ledger or any wallet holding that key. For a plain xpub, choose the Taproot account type.',
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

/**
 * What each capability is called in a sentence a user reads.
 *
 * Reads as a verb phrase after "to": "…to sell a cat", "…to inscribe".
 * These are not row labels: on the sell screen the page is already the
 * label, so nothing needs to say "Sell (create an offer)".
 */
const ACTION_PHRASE: Record<WalletCapability, string> = {
  [WalletCapability.Cat21Mint]: 'mint a cat',
  [WalletCapability.Cat21Transfer]: 'send a cat',
  [WalletCapability.Cat21OfferCreate]: 'sell a cat',
  [WalletCapability.Cat21OfferAccept]: 'buy a cat',
  [WalletCapability.Inscription]: 'inscribe',
  [WalletCapability.InscriptionParentChild]: 'add to a collection',
  [WalletCapability.SignMessage]: 'sign a message',
};

/** "A", "A or B", "A, B or C" — no serial comma, as spoken. */
function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * `blocked` - this wallet cannot do it; the button does not work.
 * `precheck` - it can, once the person changes something first.
 */
export type WalletActionNoticeKind = 'blocked' | 'precheck';

export interface WalletActionNotice {
  kind: WalletActionNoticeKind;
  /**
   * The whole thing as one finished sentence, for a surface with room
   * for prose. Print it; do not reword or append to it.
   *
   * On a narrow surface prefer the parts below. Seven wallet names read
   * as options inside a wide paragraph and as a wall inside a column,
   * because prose gives the reader no way to scan them.
   */
  message: string;
  /** Why, on its own. Ends in a full stop; never names other wallets. */
  reason: string;
  /**
   * The wallets that CAN do it here, in matrix order, as labels.
   *
   * Render them as a list when the surface is narrow. Never truncate:
   * the reader's question is "is the wallet I already have in here?",
   * and a shortened list cannot answer it. Empty for a precheck, and
   * empty when nothing else on this platform can do it either.
   */
  alternatives: string[];
  /** The action in the reader's words, e.g. "sell a cat", for a heading. */
  actionPhrase: string;
}

/**
 * The one thing to say at an action, for the wallet that is connected,
 * or `null` when there is nothing to say and the button just works.
 *
 * A consumer never composes this. The alternatives are read out of the
 * matrix at call time rather than written into a string, so adding or
 * removing a wallet updates every site at once and no site can ship a
 * list that has gone stale.
 */
export function walletActionNotice(
  wallet: KnownOrdinalWalletType,
  capability: WalletCapability,
  options: { platform?: WalletPlatform } = {},
): WalletActionNotice | null {
  const platform = options.platform ?? WalletPlatform.Desktop;
  const status = capabilityOf(wallet, capability);
  const label = walletMatrixEntry(wallet)?.label ?? wallet;
  const phrase = ACTION_PHRASE[capability];

  if (status.support !== CapabilitySupport.Unsupported) {
    return status.caveat
      ? {
          kind: 'precheck',
          message: status.caveat,
          reason: status.caveat,
          alternatives: [],
          actionPhrase: phrase,
        }
      : null;
  }

  const reason = status.caveat ?? `${label} cannot ${phrase}.`;
  // No need to exclude this wallet: we only get here when it is
  // Unsupported, and walletsSupporting never returns those.
  const alternatives = walletsSupporting(capability, { platform }).map(entry => entry.label);

  const wayForward = alternatives.length
    ? ` Connect ${orList(alternatives)} to ${phrase}.`
    : '';

  return {
    kind: 'blocked',
    message: `${reason}${wayForward}`,
    reason,
    alternatives,
    actionPhrase: phrase,
  };
}

/**
 * What the owner has to know about leaving a cat in this wallet, or
 * `null` when there is nothing to say.
 *
 * Ask this wherever an action ends with a cat in the connected wallet,
 * which is a mint or an accepted offer. A send does not need it: the cat
 * is on its way out.
 */
export function walletCustodyCaveat(wallet: KnownOrdinalWalletType): string | null {
  return walletMatrixEntry(wallet)?.custodyCaveat ?? null;
}
