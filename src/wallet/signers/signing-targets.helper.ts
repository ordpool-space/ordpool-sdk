import * as btc from '@scure/btc-signer';

import { PsbtSigningTarget, SignAndBroadcastInput } from '../wallet.service.types';

/**
 * Normalises a SignAndBroadcastInput to its effective signing-targets list.
 *
 * Two sources, in priority order:
 *   1. `input.signingMap` — explicit per-address, per-index list (new flows).
 *   2. Fallback default — single row `[{ address: paymentAddress, indexes: [0],
 *      sigHash: SigHash.ALL }]` (mint's pre-signingMap shape).
 *
 * Every shipping cat-flow uses SIGHASH_ALL. Rows that don't carry an
 * explicit sigHash receive SIGHASH_ALL here so the per-signer call sites
 * don't all repeat the default.
 */
export function resolveSigningTargets(
  input: SignAndBroadcastInput
): ReadonlyArray<Required<PsbtSigningTarget>> {
  const raw =
    input.signingMap && input.signingMap.length > 0
      ? input.signingMap
      : [{ address: input.paymentAddress, indexes: [0] }];

  return raw.map((row) => ({
    address: row.address,
    indexes: row.indexes,
    sigHash: row.sigHash ?? btc.SigHash.ALL,
  }));
}
