/**
 * Sats-connect's `AddressPurpose` enum, redeclared locally.
 *
 * Same reason `network.ts` redeclares `BitcoinNetworkType`: importing the
 * real enum is a VALUE import, and sats-connect's index pulls its whole
 * cluster (sats-connect/ui, bowser, valibot and axios) into anything that
 * touches it. Because `wallet.service.types` imported it, EVERY connector
 * dragged that cluster: `unisat.connector` alone measured 601 kB, of which
 * 171 kB was sats-connect it never calls.
 *
 * These are wire-protocol strings, copied from the enum in
 * `@sats-connect/core/dist/index.d.ts` (Ordinals = "ordinals",
 * Payment = "payment", Stacks = "stacks", Starknet = "starknet",
 * Spark = "spark"), so a local copy compares equal to whatever a wallet
 * sends back, with no sats-connect code loaded.
 *
 * `xverse.connector` and `xverse.signer` still import sats-connect for
 * real: they call `getAddress` and `addListener`. That is the honest cost
 * of Xverse, and it is paid only by whoever loads the connector roster.
 */
export const AddressPurpose = {
  Ordinals: 'ordinals',
  Payment: 'payment',
  Stacks: 'stacks',
  Starknet: 'starknet',
  Spark: 'spark',
} as const;
export type AddressPurpose = (typeof AddressPurpose)[keyof typeof AddressPurpose];
