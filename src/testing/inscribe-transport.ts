import type {
  InscribeBroadcastTransport,
  PackageAcceptResult,
  PackageSubmitOutcome,
} from '../inscribe/inscribe-package-broadcast.js';
import { txidOf } from '../inscribe/inscribe-signed-pair.js';

/**
 * A transport for SDK specs that accepts everything and records what reached
 * it. Its answers have the shape electrs returns for `POST /txs/test` and
 * `POST /txs/package` (captured from bitcoind v30.2 behind ordpool-electrs), so
 * the code under test parses the same fields it parses in production.
 *
 * `submitted` is the flat list of hexes the package carried, in order, so a
 * spec reads `submitted[0]` as the commit and `submitted[1]` as the reveal.
 * `calls` lists every method hit, for asserting that nothing was sent.
 */
export interface RecordingInscribeTransport extends InscribeBroadcastTransport {
  readonly submitted: string[];
  readonly calls: string[];
}

export function recordingInscribeTransport(options: {
  /** Have `testmempoolaccept` refuse the last transaction with this reason. */
  refuseLast?: string;
} = {}): RecordingInscribeTransport {
  const submitted: string[] = [];
  const calls: string[] = [];
  return {
    submitted,
    calls,
    async testPackage(hexes): Promise<PackageAcceptResult[]> {
      calls.push('testPackage');
      return hexes.map((h, i) => {
        const txid = txidOf(h);
        const refused = options.refuseLast !== undefined && i === hexes.length - 1;
        return {
          txid,
          wtxid: txid,
          allowed: !refused,
          'reject-reason': refused ? options.refuseLast ?? null : null,
        };
      });
    },
    async submitPackage(hexes): Promise<PackageSubmitOutcome[]> {
      calls.push('submitPackage');
      submitted.push(...hexes);
      const txResults: Record<string, { txid: string; error: null }> = {};
      for (const h of hexes) {
        const txid = txidOf(h);
        txResults[txid] = { txid, error: null };
      }
      return [{ endpoint: 'recording', kind: 'result', result: { package_msg: 'success', 'tx-results': txResults } }];
    },
    async sendTransaction(h): Promise<string> {
      calls.push('sendTransaction');
      return txidOf(h);
    },
  };
}
