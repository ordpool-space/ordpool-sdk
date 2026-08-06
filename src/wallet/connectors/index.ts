import {
  KnownOrdinalWallet,
  WalletConnector,
  WindowLike,
} from '../wallet.service.types';
import { albyConnector } from './alby.connector';
import { cat21walletConnector } from './cat21wallet.connector';
import { leatherConnector } from './leather.connector';
import { okxConnector } from './okx.connector';
import { phantomConnector } from './phantom.connector';
import { unisatConnector } from './unisat.connector';
import { wizzConnector } from './wizz.connector';
import { xverseConnector } from './xverse.connector';


/**
 * Read-side wallet roster. New connectors get added here. The
 * `WalletService` walks this list for detection and dispatch.
 *
 * Detection order matters — first-installed shows up first in the
 * picker. CAT-21 wallet leads because it's OUR wallet (the
 * maintainer ships this one). Xverse follows as the headline
 * external recommendation. Everything else by installed-base
 * heuristic.
 *
 * Binance is NOT in this list. The connector + signer files stay on
 * disk because Binance's developer docs document `window.binancew3w
 * .bitcoin` with a Unisat-shaped API, but the v1.17.2 binary never
 * actually exposes that surface — detect-by-`binancew3w.bitcoin`
 * returns false for every real install, AND no user-side smoke test
 * is possible because the API doesn't ship. The picker entry would
 * be a broken promise. If Binance ever ships the documented surface,
 * re-add `binanceConnector` to this list, the existing connector +
 * signer auto-activates.
 */
export const walletConnectors: readonly WalletConnector[] = [
  cat21walletConnector,
  xverseConnector,
  leatherConnector,
  unisatConnector,
  wizzConnector,
  okxConnector,
  phantomConnector,
  albyConnector,
];

/**
 * Sort the roster into installed / not-installed buckets based on
 * which extension shims are visible on `win`. Order matches
 * `walletConnectors`, so the picker can render either bucket
 * deterministically.
 *
 * `connectors` defaults to the live roster — tests pass their own
 * stub list to keep assertions tight.
 */
export function detectInstalledWallets(
  win: WindowLike | undefined,
  connectors: readonly WalletConnector[] = walletConnectors,
): { installedWallets: KnownOrdinalWallet[]; notInstalledWallets: KnownOrdinalWallet[] } {

  const installedWallets: KnownOrdinalWallet[] = [];
  const notInstalledWallets: KnownOrdinalWallet[] = [];

  for (const connector of connectors) {
    (connector.detect(win) ? installedWallets : notInstalledWallets).push(connector.wallet);
  }

  return { installedWallets, notInstalledWallets };
}

export { albyConnector } from './alby.connector';
export { binanceConnector } from './binance.connector';
export { cat21walletConnector } from './cat21wallet.connector';
export { leatherConnector } from './leather.connector';
export { okxConnector } from './okx.connector';
export { phantomConnector } from './phantom.connector';
export { unisatConnector } from './unisat.connector';
export { wizzConnector } from './wizz.connector';
export { xverseConnector } from './xverse.connector';
