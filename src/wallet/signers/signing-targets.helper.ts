import * as btc from '@scure/btc-signer';

import { PsbtSigningTarget } from '../wallet.service.types.js';

/**
 * Both `SignMultiInputAndBroadcastInput` and `SignPsbtOnlyInput` carry a
 * `signingMap`. The helper only consults that field, so we pin the
 * argument shape to just it — keeps both call sites usable from one
 * helper without an unsound union.
 */
type WithSigningMap = { signingMap: ReadonlyArray<PsbtSigningTarget> };

/**
 * Normalises a signingMap to a non-empty array of fully-defaulted
 * rows. Per-row `sigHash` defaults to SIGHASH_ALL — every cat-flow
 * we ship today commits under SIGHASH_ALL, single source for the
 * default lives here so the 10+ signers don't each repeat it.
 *
 * Throws if the signingMap is empty — that's a caller bug, not a
 * runtime degradation.
 */
export function resolveSigningTargets(
  input: WithSigningMap
): ReadonlyArray<{ address: string; indexes: number[]; sigHash: number; publicKey?: string }> {
  if (!input.signingMap || input.signingMap.length === 0) {
    throw new Error('signingMap is empty: pass at least one (address, indexes) row');
  }
  return input.signingMap.map((row) => ({
    address: row.address,
    indexes: row.indexes,
    sigHash: row.sigHash ?? btc.SigHash.ALL,
    // Preserved for the address-filter signers to shim this row's
    // wallet-side address with the correct key (defaults to the flow's
    // paymentPublicKey at the signer when undefined).
    publicKey: row.publicKey,
  }));
}

/**
 * Project the resolved signing targets onto the `{ address, signingIndexes,
 * sigHash }` row shape the sats-connect family (Xverse, Phantom) hands to its
 * wallet: one row per target, indexes kept grouped.
 */
export function signingTargetsToInputsToSign(
  input: WithSigningMap,
): { address: string; signingIndexes: number[]; sigHash: number }[] {
  return resolveSigningTargets(input).map((t) => ({
    address: t.address,
    signingIndexes: t.indexes,
    sigHash: t.sigHash,
  }));
}

/**
 * Flatten the resolved signing targets to one ordered list of input indexes,
 * for the Leather-family wallets (Leather, cat21-wallet) whose signPsbt
 * addresses inputs by index rather than by address.
 */
export function flattenSigningIndexes(input: WithSigningMap): number[] {
  const flat: number[] = [];
  for (const t of resolveSigningTargets(input)) {
    for (const i of t.indexes) flat.push(i);
  }
  return flat;
}
