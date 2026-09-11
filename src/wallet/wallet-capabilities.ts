import { COIN_CHECK_PROMISE } from '../family/coin-check-promise';
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
   * This wallet hands out ONE address and uses it for both spendable coins
   * and ordinals.
   *
   * Not a verdict on the wallet: it is a structural fact with a consequence.
   * With no separation, every coin the wallet might spend on a fee is also a
   * coin that could be carrying an inscription, a rune, a rare sat or a cat,
   * so a routine payment made anywhere outside our flows can send an asset to
   * a miner. A wallet that keeps two addresses cannot do that by accident.
   *
   * Five of the nine wallets we ship are like this, so it is a category, not
   * a wallet to single out. Derive the user-facing sentence from
   * {@link walletCustodyCaveat} rather than writing per-wallet copy.
   *
   * For a CONNECTED wallet prefer {@link usesSingleAddress}, which compares
   * the two addresses actually returned and is therefore ground truth rather
   * than our record of it.
   */
  singleAddress?: true;
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
    singleAddress: true,
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
    singleAddress: true,
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
    singleAddress: true,
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
        caveat: "Alby can't send a cat: it signs all or nothing, and sending needs the cat and your fee coins signed apart.",
      },
      [WalletCapability.Cat21OfferCreate]: {
        support: CapabilitySupport.Unsupported,
        caveat: "Alby can't sell a cat: it signs all or nothing, and a trade needs each side to sign only its own part.",
      },
      [WalletCapability.Cat21OfferAccept]: {
        support: CapabilitySupport.Unsupported,
        caveat: "Alby can't buy a cat: it signs all or nothing, and a trade needs each side to sign only its own part.",
      },
      [WalletCapability.Inscription]: { support: CapabilitySupport.Proven },
      [WalletCapability.InscriptionParentChild]: {
        support: CapabilitySupport.Unsupported,
        caveat: "Alby can't add to a collection: it signs all or nothing, and a collection needs one part left unsigned. Plain inscriptions work.",
      },
      [WalletCapability.SignMessage]: { support: CapabilitySupport.Unsupported },
    },
    singleAddress: true,
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
    singleAddress: true,
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
 * @deprecated Prefer `usesSingleAddress(connectedWallet)` as the gate and
 * {@link singleAddressCaveat} for the sentence. This gates on the matrix
 * RECORD of how a wallet is built; that gates on the two addresses the
 * wallet actually returned, which is ground truth and cannot be stale. A
 * consumer carried a comment listing OKX as address-separating for a year
 * while its own code did the right thing, which is exactly the gap between
 * the two.
 *
 * This was written for a pre-connect caller, and then §7.2 established that
 * the warning is connected-only, because address equality is unanswerable
 * before a wallet connects. That left it with no supported case. Kept for
 * now only because two consumers are building against this pin and removing
 * an export mid-round would break them; it goes when the round closes.
 *

 * The sentence to show when a wallet keeps coins and assets on one address,
 * or `null` when it separates them and there is nothing to say.
 *
 * One shared sentence for the whole category rather than per-wallet copy:
 * five of the nine wallets we ship are like this, and singling one out reads
 * as a verdict on that product when it is a property of half the field.
 *
 * Show it wherever the connected wallet ENDS UP HOLDING a cat, which is a
 * mint or an accepted offer, never a send. See the capability table on
 * {@link WalletMatrixEntry.singleAddress}.
 */
export function walletCustodyCaveat(
  wallet: KnownOrdinalWalletType,
  options: { assets?: string } = {},
): string | null {
  if (!walletMatrixEntry(wallet)?.singleAddress) return null;
  return singleAddressCaveat(options.assets);
}

/**
 * Shown for every single-address wallet.
 *
 * States the mechanism, not a verdict, and gives the two ways out: a wallet
 * that separates the two, or a fresh address kept for tools that check a coin
 * before spending it. Ours are named because they are the ones that check;
 * that is a capability claim about our own products, not a ranking of anyone
 * else's.
 *
 * `assets` names what the reader believes they own, so each site says the
 * thing its audience came for: cats on cat21.space, cubes on cubes. It is
 * only the noun; the mechanism is identical, because a single-address wallet
 * can spend the sat ANY asset lives on.
 *
 * The closing clause says "assets" rather than the noun, because the scan is
 * genuinely wider than any one product: inscriptions, runes, rare sats and
 * cats. Worth knowing that every inscribe through this SDK also mints cats
 * (`lockTime: CAT21_LOCK_TIME` in the commit and reveal helpers), so a cube
 * holder owns cats too, whether or not they came for them.
 */
/**
 * How the caveat opens: named when we know which wallet is connected,
 * generic when we do not.
 *
 * Naming it is worth doing because "this wallet" makes a reader check which
 * wallet we mean before they can act; "Your UniSat wallet" is already the
 * thing sitting in their browser.
 *
 * Pass the wallet's display label (`KnownOrdinalWallets[type].label`), which
 * carries the brand's own casing. The label is NOT always a bare brand name:
 * Binance ships as "Binance Web3 Wallet", and Binance is one of the five
 * wallets that trigger this caveat, so appending " wallet" unconditionally
 * would ship "Your Binance Web3 Wallet wallet" to real readers.
 */
function singleAddressCaveatOpener(walletName?: string): string {
  if (!walletName) return 'This wallet';
  return /\bwallet$/i.test(walletName.trim())
    ? `Your ${walletName.trim()}`
    : `Your ${walletName.trim()} wallet`;
}

export function singleAddressCaveat(assets = 'cats', walletName?: string): string {
  return (
    `${singleAddressCaveatOpener(walletName)} keeps your coins and your ${assets} at one address. That is fine here, because `
    + `everything in the ordpool family ${COIN_CHECK_PROMISE}. `
    + `Other sites do not look, so a payment made elsewhere can spend the sat one of your `
    + `${assets} lives on and tip it to a miner. Start a fresh address here and keep it for `
    + 'cat21.space, ordpool.space, cubes.haushoppe.art and CAT-21 wallet, or use a wallet that '
    + `keeps your coins and your ${assets} apart.`
  );
}

/** The default wording, for a heading or a link that needs the sentence itself. */
export const SINGLE_ADDRESS_CAVEAT = singleAddressCaveat();

/**
 * The visible label on the compact indicator that rides a connected-wallet
 * pill, beside its amber marker.
 *
 * Deliberately asset-agnostic and therefore NOT parameterised: it names the
 * arrangement, and the arrangement is identical on every site. One string
 * everywhere is one fewer thing that can drift between three repos.
 *
 * Sized for a pill. If it ever needs more words, it has stopped being a
 * compact indicator and the design question is a different one.
 */
export const SINGLE_ADDRESS_PILL_LABEL = 'One address';

/**
 * The accessible name for that marker, for a reader who never sees the amber.
 *
 * Colour and shape carry nothing to a screen reader, and amber is exactly the
 * pairing a colour-blind reader is most likely to miss, so this string is the
 * whole message rather than a label for the widget. It announces the
 * CONDITION and the affordance in one breath, never "warning icon".
 *
 * Longer than {@link SINGLE_ADDRESS_PILL_LABEL} on purpose: a pill has a
 * width, an accessible name has a breath.
 */
export function singleAddressPillAccessibleName(assets = 'cats'): string {
  return `This wallet keeps your coins and your ${assets} on one address. Open for details.`;
}

/**
 * Whether a CONNECTED wallet is handing out one address for both roles.
 *
 * Ground truth, and preferred over the matrix flag whenever a wallet is
 * connected: it compares the addresses actually returned, so it stays right
 * if a wallet changes its model or a user configures it unusually. The matrix
 * flag is for the case where nobody has connected yet.
 */
export function usesSingleAddress(
  wallet: { ordinalsAddress?: string; paymentAddress?: string } | null | undefined,
): boolean {
  if (!wallet?.ordinalsAddress || !wallet?.paymentAddress) return false;
  return wallet.ordinalsAddress === wallet.paymentAddress;
}
