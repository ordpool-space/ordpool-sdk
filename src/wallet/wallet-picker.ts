import {
  WalletCapability,
  WalletPlatform,
  WALLET_MATRIX,
  walletsSupporting,
} from './wallet-capabilities.js';
import { walletInAppBrowserDeepLink } from './wallet-deeplink.js';
import { detectInstalledWallets } from './connectors/index.js';
import { KnownOrdinalWalletType, WindowLike } from './wallet.service.types.js';
import { KnownOrdinalWallets } from './known-ordinal-wallets.js';

/**
 * What a person does next with this row. Drives the button, and only
 * the button: a picker row carries no other affordance.
 */
export type WalletPickerAction =
  | 'connect'
  | 'install'
  | 'open-in-app'
  | 'connect-xpub'
  /** Supported, but only on the OTHER platform. The button is inert. */
  | 'use-on-desktop'
  | 'use-on-mobile';

/**
 * One row of a wallet picker: a logo, a name, and one button.
 *
 * Deliberately nothing else. No signing mode, no capability list, no
 * support level. Someone at this screen is trying to connect; anything we
 * know about a wallet waits until it can change what they do.
 *
 * Platform is the one exception, and it earns it. A wallet unreachable on
 * this device used to be dropped from the list entirely, on the reasoning
 * that telling a phone user about a desktop extension answers a question
 * they did not ask. That reasoning does not survive its own picker: the
 * `install` action exists purely to tell someone about a wallet they do
 * NOT have, so the list already answers unasked questions. Meanwhile
 * someone holding Leather on their phone saw no Leather and no reason,
 * and concluded the site does not support it.
 *
 * So nothing is hidden. `reachableHere` says whether this wallet can be
 * used on this device, and the unreachable rows carry an inert
 * `use-on-desktop` / `use-on-mobile` action instead of vanishing.
 */
export interface WalletPickerRow {
  wallet: KnownOrdinalWalletType;
  label: string;
  /** `data:image/svg+xml;base64,…`, ready for an `<img src>`. */
  logo: string;
  /** Whether this wallet's provider is reachable in this browser right now. */
  installed: boolean;
  /**
   * Whether this wallet can be used on THIS device at all.
   *
   * False means supported by the SDK but only on the other platform, so
   * the row is discovery rather than an affordance: render it muted, in a
   * separate group, and do not wire its button.
   */
  reachableHere: boolean;
  action: WalletPickerAction;
  /** The button's text. Comes from here so the three sites cannot drift. */
  actionLabel: string;
  /** Where `install` sends them. */
  installUrl?: string;
  /** Where `open-in-app` sends them; present only when we have a verified scheme. */
  deepLink?: string;
}

export interface WalletPickerOptions {
  /** The window to detect providers in. Omit in SSR: every row comes back not-installed. */
  win?: WindowLike;
  /**
   * Where this picker is rendering. Wallets unreachable here are absent,
   * never badged. Defaults to {@link detectWalletPlatform} over `win`;
   * pass it only to override, never from a CSS breakpoint.
   */
  platform?: WalletPlatform;
  /**
   * Set when the picker serves ONE action ("sell this cat"). Wallets that
   * cannot do it are dropped, so the list cannot offer a dead end. Omit
   * for a plain login, where every wallet reachable on this device shows.
   */
  capability?: WalletCapability;
  /** The page to reopen inside a wallet's own browser, for `open-in-app`. */
  currentUrl?: string;
}

/**
 * Whether wallets here are reached as browser extensions or inside a
 * wallet's own in-app browser.
 *
 * This is a property of the DEVICE, never of the viewport. A desktop
 * browser dragged narrow is still a desktop: its extensions keep
 * working, and no in-app browser exists to send anyone to. Deriving it
 * from a CSS breakpoint would change which wallets a person is offered
 * when they resize their window.
 *
 * Unknown environments answer `Desktop`, which lists more wallets rather
 * than fewer and never routes anyone to an in-app browser they cannot
 * open.
 */
export function detectWalletPlatform(win: WindowLike | undefined): WalletPlatform {
  const nav = win?.navigator;
  const ua = nav?.userAgent ?? '';

  if (/Android|iPhone|iPad|iPod/i.test(ua)) return WalletPlatform.Mobile;

  // iPadOS 13+ reports a desktop Safari user agent; the touch count is
  // what still separates it from a Mac.
  if (/Macintosh/i.test(ua) && (nav?.maxTouchPoints ?? 0) > 1) return WalletPlatform.Mobile;

  return WalletPlatform.Desktop;
}

/**
 * The rows of a wallet picker, in matrix order, ready to render.
 *
 * Platform is a filter here, never a badge: a wallet unreachable on this
 * device is simply not in the list, because telling someone their phone
 * cannot run a browser extension answers a question they did not ask.
 */
export function walletPickerRows(options: WalletPickerOptions = {}): WalletPickerRow[] {
  const platform = options.platform ?? detectWalletPlatform(options.win);
  const other = platform === WalletPlatform.Mobile
    ? WalletPlatform.Desktop
    : WalletPlatform.Mobile;

  // Every wallet that can do the job on EITHER platform. Capability still
  // filters (a picker for "sell this cat" must not offer a wallet that
  // cannot sell), but platform no longer removes rows, it only decides
  // which are actionable here.
  const usable = options.capability !== undefined
    ? walletsSupporting(options.capability, {})
    : WALLET_MATRIX;

  const { installedWallets } = detectInstalledWallets(options.win);
  const installedTypes = new Set(installedWallets.map(w => w.type));

  const rows = usable.map((entry): WalletPickerRow => {
    const meta = KnownOrdinalWallets[entry.wallet];
    const installed = installedTypes.has(entry.wallet);
    const reachableHere = entry.platforms.includes(platform);

    // Supported, but not on this device. Discovery, not an affordance.
    if (!reachableHere) {
      return {
        wallet: entry.wallet,
        label: entry.label,
        logo: meta.logo,
        installed: false,
        reachableHere: false,
        action: other === WalletPlatform.Desktop ? 'use-on-desktop' : 'use-on-mobile',
        actionLabel: other === WalletPlatform.Desktop ? 'Desktop only' : 'Mobile only',
      };
    }

    if (entry.signingMode === 'watch-only') {
      return {
        wallet: entry.wallet,
        label: entry.label,
        logo: meta.logo,
        installed: true,
        reachableHere: true,
        action: 'connect-xpub',
        // Just "Connect": the row's own name already says Watch-only
        // (xpub), and repeating it made this the widest button in the
        // list, squeezing the name column until the label wrapped to
        // three lines while every other row stayed on one.
        actionLabel: 'Connect',
      };
    }

    if (installed) {
      return {
        wallet: entry.wallet,
        label: entry.label,
        logo: meta.logo,
        installed: true,
        reachableHere: true,
        action: 'connect',
        actionLabel: 'Connect',
      };
    }

    // Not injected here. On mobile a wallet is reached by reopening the
    // page inside its own browser, so that is the next step, not an
    // install. Only offered where we have a scheme from the wallet's
    // own docs; otherwise fall through and point at the download page.
    const deepLink = platform === WalletPlatform.Mobile && options.currentUrl
      ? walletInAppBrowserDeepLink(entry.wallet, options.currentUrl)
      : null;

    if (deepLink) {
      return {
        wallet: entry.wallet,
        label: entry.label,
        logo: meta.logo,
        installed: false,
        reachableHere: true,
        action: 'open-in-app',
        actionLabel: `Open in ${entry.label}`,
        deepLink,
      };
    }

    return {
      wallet: entry.wallet,
      label: entry.label,
      logo: meta.logo,
      installed: false,
      reachableHere: true,
      action: 'install',
      actionLabel: 'Install',
      installUrl: meta.downloadLink,
    };
  });

  // Actionability descending, so the list still leads with what works even
  // though nothing is hidden: usable here first (installed before not),
  // then the other platform's wallets as a discovery group. Ties keep
  // matrix order, which is the curated preference order.
  // Watch-only is `installed` by definition (it needs no provider), so a
  // plain installed-first sort would rocket it to the top of every picker.
  // It keeps its matrix position instead, which is last among the usable
  // rows: it is the fallback, not the recommendation.
  const rank = (r: WalletPickerRow): number =>
    !r.reachableHere ? 2 : (r.installed && r.action !== 'connect-xpub') ? 0 : 1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i)
    .map(({ row }) => row);
}
