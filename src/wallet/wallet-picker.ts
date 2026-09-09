import {
  WalletCapability,
  WalletPlatform,
  walletsForPlatform,
  walletsSupporting,
} from './wallet-capabilities';
import { walletInAppBrowserDeepLink } from './wallet-deeplink';
import { detectInstalledWallets } from './connectors';
import {
  KnownOrdinalWalletType,
  KnownOrdinalWallets,
  WindowLike,
} from './wallet.service.types';

/**
 * What a person does next with this row. Drives the button, and only
 * the button: a picker row carries no other affordance.
 */
export type WalletPickerAction = 'connect' | 'install' | 'open-in-app' | 'connect-xpub';

/**
 * One row of a wallet picker: a logo, a name, and one button.
 *
 * Deliberately nothing else. No platform badge, no signing mode, no
 * capability list, no support level, no note. Someone at this screen is
 * trying to connect; anything we know about a wallet waits until it can
 * change what they do, which is at the action, not at the door.
 */
export interface WalletPickerRow {
  wallet: KnownOrdinalWalletType;
  label: string;
  /** `data:image/svg+xml;base64,…`, ready for an `<img src>`. */
  logo: string;
  /** Whether this wallet's provider is reachable in this browser right now. */
  installed: boolean;
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
  /** Where this picker is rendering. Wallets unreachable here are absent, never badged. */
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
 * The rows of a wallet picker, in matrix order, ready to render.
 *
 * Platform is a filter here, never a badge: a wallet unreachable on this
 * device is simply not in the list, because telling someone their phone
 * cannot run a browser extension answers a question they did not ask.
 */
export function walletPickerRows(options: WalletPickerOptions = {}): WalletPickerRow[] {
  const platform = options.platform ?? WalletPlatform.Desktop;

  const reachable = options.capability !== undefined
    ? walletsSupporting(options.capability, { platform })
    : walletsForPlatform(platform);

  const { installedWallets } = detectInstalledWallets(options.win);
  const installedTypes = new Set(installedWallets.map(w => w.type));

  return reachable.map((entry): WalletPickerRow => {
    const meta = KnownOrdinalWallets[entry.wallet];
    const installed = installedTypes.has(entry.wallet);

    if (entry.signingMode === 'watch-only') {
      return {
        wallet: entry.wallet,
        label: entry.label,
        logo: meta.logo,
        installed: true,
        action: 'connect-xpub',
        actionLabel: 'Connect (xpub)',
      };
    }

    if (installed) {
      return {
        wallet: entry.wallet,
        label: entry.label,
        logo: meta.logo,
        installed: true,
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
      action: 'install',
      actionLabel: 'Install',
      installUrl: meta.downloadLink,
    };
  });
}
