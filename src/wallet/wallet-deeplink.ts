import { KnownOrdinalWalletType } from './wallet.service.types';

/**
 * Deep link that opens a URL inside a wallet's own in-app dApp browser.
 *
 * The mobile-plain-browser case: a phone browser (Safari/Chrome) has no
 * injected wallet provider, so the SDK's connect path can't run there.
 * The workaround is to bounce the user into a wallet's in-app browser,
 * where that wallet's provider IS injected, via the wallet's documented
 * Universal Link / App Link.
 *
 * Matrix-adjacent, so all three consumer sites share ONE registry
 * instead of each hardcoding (and drifting on) schemes. Returns `null`
 * when we have no scheme VERIFIED against the wallet's official
 * developer docs — the consumer then omits the deep-link affordance
 * rather than send the user to a guessed URL. Adding a wallet requires
 * reading its docs, never guessing (workspace no-guessing rule).
 *
 * @param wallet the wallet to bounce into
 * @param targetUrl the page to open inside the wallet's in-app browser
 * @returns the deep link, or `null` if no verified scheme exists
 */
export function walletInAppBrowserDeepLink(
  wallet: KnownOrdinalWalletType,
  targetUrl: string,
): string | null {
  switch (wallet) {
    case KnownOrdinalWalletType.xverse:
      // Verified against docs.xverse.app/sats-connect/guides/mobile-integration
      // (read 2026-08-26): Universal Link on iOS, Application Link on
      // Android, same format for both. `browser` is the ONLY supported
      // deep-link parameter. The value follows Xverse's documented
      // examples (`url=<target>`, e.g. url=www.gamma.io). The `xverse://`
      // custom scheme is deprecated in favour of this.
      return `https://connect.xverse.app/browser?url=${targetUrl}`;

    default:
      // OKX, Binance, Phantom, …: no in-app-browser deep-link scheme has
      // been verified against the wallet's official docs. Return null so
      // consumers hide the affordance instead of guessing a URL.
      return null;
  }
}
