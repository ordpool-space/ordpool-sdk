import * as btc from '@scure/btc-signer';

import {
  PsbtSigningTarget,
  SignMultiInputAndBroadcastInput,
} from '../wallet.service.types';

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
  input: SignMultiInputAndBroadcastInput
): ReadonlyArray<Required<PsbtSigningTarget>> {
  if (!input.signingMap || input.signingMap.length === 0) {
    throw new Error('signingMap is empty — pass at least one (address, indexes) row');
  }
  return input.signingMap.map((row) => ({
    address: row.address,
    indexes: row.indexes,
    sigHash: row.sigHash ?? btc.SigHash.ALL,
  }));
}
