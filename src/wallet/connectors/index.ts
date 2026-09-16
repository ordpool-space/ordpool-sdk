import {
  KnownOrdinalWallet,
  WalletConnector,
  WindowLike,
} from '../wallet.service.types.js';
import { albyConnector } from './alby.connector.js';
import { binanceConnector } from './binance.connector.js';
import { cat21walletConnector } from './cat21wallet.connector.js';
import { leatherConnector } from './leather.connector.js';
import { okxConnector } from './okx.connector.js';
import { phantomConnector } from './phantom.connector.js';
import { unisatConnector } from './unisat.connector.js';
import { wizzConnector } from './wizz.connector.js';
import { xverseConnector } from './xverse.connector.js';


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
 * Binance is in the roster so it stays consistent with the capability
 * matrix (which lists Binance): a matrix-driven picker's connect
 * resolves to this connector instead of throwing "unknown wallet". Its
 * `detect` gates real availability. Binance's developer docs document
 * `window.binancew3w.bitcoin` with a Unisat-shaped API, but the shipped
 * binary (v1.17.2) injects only `window.binancew3w.{wallet, ethereum,
 * solana, tron, sui, tonconnect}` and no `.bitcoin`, so `detect` returns
 * false on every current install and Binance shows as not-installed. The
 * connector + signer auto-activate the moment Binance exposes the
 * documented surface.
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
  binanceConnector,
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

export { albyConnector } from './alby.connector.js';
export { binanceConnector } from './binance.connector.js';
export { cat21walletConnector } from './cat21wallet.connector.js';
export { leatherConnector } from './leather.connector.js';
export { okxConnector } from './okx.connector.js';
export { phantomConnector } from './phantom.connector.js';
export { unisatConnector } from './unisat.connector.js';
export { wizzConnector } from './wizz.connector.js';
export { xverseConnector } from './xverse.connector.js';
