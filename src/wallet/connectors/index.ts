import { WalletConnector } from '../wallet.service.types';
import { leatherConnector } from './leather.connector';
import { unisatConnector } from './unisat.connector';
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
];

export { leatherConnector } from './leather.connector';
export { unisatConnector } from './unisat.connector';
export { xverseConnector } from './xverse.connector';
