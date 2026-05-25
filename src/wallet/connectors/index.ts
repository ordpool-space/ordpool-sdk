import {
  KnownOrdinalWallet,
  WalletConnector,
  WindowLike,
} from '../wallet.service.types';
import { leatherConnector } from './leather.connector';
import { okxConnector } from './okx.connector';
import { unisatConnector } from './unisat.connector';
import { wizzConnector } from './wizz.connector';
import { xverseConnector } from './xverse.connector';


/**
 * Read-side wallet roster. New connectors get added here. The
 * `WalletService` walks this list for detection and dispatch.
 *
 * Detection order matters — first-installed shows up first in the
 * picker. Xverse leads because it's our headline recommendation.
 */
export const walletConnectors: readonly WalletConnector[] = [
  xverseConnector,
  leatherConnector,
  unisatConnector,
  wizzConnector,
  okxConnector,
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

export { leatherConnector } from './leather.connector';
export { okxConnector } from './okx.connector';
export { unisatConnector } from './unisat.connector';
export { wizzConnector } from './wizz.connector';
export { xverseConnector } from './xverse.connector';
