import { Observable, from, map, of } from 'rxjs';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import type { CreateInscribeTransactionsResult } from './inscription.service.helper.js';
import { InscribeBroadcastTransport, broadcastCommitAndReveal } from './inscribe-package-broadcast.js';

/*
 * Internal to the inscribe orchestrators and re-exported by no barrel: how they
 * collect signed transactions without sending them, and then send the pair.
 */

/** What every inscribe orchestrator reports once the pair is out. */
export interface SentInscribePair {
  commitTxId: string;
  revealTxId: string;
  commitAddress: string;
  ephemeral: CreateInscribeTransactionsResult['ephemeral'];
  fees: unknown;
}

/**
 * A `broadcast` callback for the signers that sends nothing. It keeps the
 * signed wire hex and answers with its txid, so every wallet signature is in
 * hand before anything leaves the device. The hook is informational, so a
 * throw inside it is not allowed to abort a signing the user already approved.
 */
export function holdSigned(onSigned?: (signedHex: string) => void): {
  broadcast: (wireHex: string) => Observable<string>;
  take: () => string;
} {
  let held: string | null = null;
  return {
    broadcast: (wireHex: string) => {
      held = wireHex;
      if (onSigned) {
        try { onSigned(wireHex); } catch { /* informational hook, see above */ }
      }
      return of(txidOf(wireHex));
    },
    take: () => {
      if (held === null) throw new Error('the signer finished without handing over a signed transaction');
      return held;
    },
  };
}

/** The txid of a wire-format transaction (witness excluded, as Core computes it). */
export function txidOf(wireHex: string): string {
  return btc.Transaction.fromRaw(hex.decode(wireHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  }).id;
}

/** Send an inscribe's signed commit and reveal, then report both txids. */
export function sendPair<B extends {
  commitAddress: string;
  ephemeral: CreateInscribeTransactionsResult['ephemeral'];
  fees: unknown;
}>(
  transport: InscribeBroadcastTransport,
  built: B,
  commitHex: string,
  revealHex: string,
): Observable<SentInscribePair & { fees: B['fees'] }> {
  const commitTxId = txidOf(commitHex);
  const revealTxId = txidOf(revealHex);
  return from(broadcastCommitAndReveal(transport, {
    commitHex,
    revealHex,
    commitTxId,
    revealTxId,
    commitAddress: built.commitAddress,
    ephemeral: built.ephemeral,
  })).pipe(
    map(() => ({
      commitTxId,
      revealTxId,
      commitAddress: built.commitAddress,
      ephemeral: built.ephemeral,
      fees: built.fees,
    })),
  );
}

