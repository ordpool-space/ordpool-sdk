import { InjectionToken } from '@angular/core';

import { Network } from './network';

/**
 * Consumers provide this in their root injector — `useValue: Network.Mainnet`
 * is the only realistic answer in the ordpool frontend today.
 *
 * Lives in its own file so `network.ts` (enum + converters) stays
 * Angular-free and tree-shakes / runs in Node without dragging in
 * `@angular/core`.
 */
export const SDK_NETWORK = new InjectionToken<Network>('SDK_NETWORK');
