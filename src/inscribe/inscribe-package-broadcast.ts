/**
 * Getting an inscription's commit and reveal into the mempool together.
 *
 * The commit pays into an address only the ephemeral key can spend; the reveal
 * spends it. A commit that lands without its reveal leaves the funds there. So
 * nothing is sent until both transactions are signed and the node has accepted
 * them as a package in a dry run.
 *
 * Bitcoin Core gives no atomicity to lean on. `submitpackage` keeps every
 * transaction that passes on its own ("If any transaction passes, it will be
 * accepted to mempool", `bitcoin-cli help submitpackage`, v30.2) and answers
 * with a normal RPC result, which electrs returns as HTTP 200 with
 * `package_msg: "transaction failed"`. Hence the order below:
 *
 *  1. `testmempoolaccept` over the pair. It validates both together and sends
 *     nothing; any refusal stops here with the funds untouched.
 *  2. `submitpackage`. Success is `package_msg === "success"`, never the HTTP
 *     status.
 *  3. If the commit may be in the mempool without the reveal (the mempool
 *     changed between 1 and 2, or an endpoint failed mid-request), the signed
 *     reveal is sent on its own. Only if that fails too does the caller get the
 *     recovery data, as an {@link InscribeRevealPendingError}.
 *
 * A retry after an earlier attempt that left the commit out meets a dry run
 * that refuses the commit with `txn-already-in-mempool` (and leaves the reveal
 * unvalidated), while `submitpackage` would accept the pair. That case is
 * recognised and finished by checking and sending the reveal alone.
 */

import { InscribeInputError, InscribeRevealPendingError } from './inscribe-errors.js';

/** One entry of Core's `testmempoolaccept`, as electrs `POST /txs/test` returns it. */
export interface PackageAcceptResult {
  txid: string;
  wtxid?: string;
  /**
   * `true` only when Core would accept this transaction. `null` when Core did
   * not finish validating it because another transaction in the package failed.
   */
  allowed: boolean | null;
  'reject-reason'?: string | null;
}

/**
 * Core's `submitpackage` result, as electrs `POST /txs/package` returns it.
 * Keyed by wtxid. Returned with HTTP 200 whether or not the package went in.
 */
export interface PackageSubmitResult {
  package_msg: string;
  'tx-results': Record<string, { txid: string; error?: string | null }>;
}

/** One endpoint's answer to a package submission. Returned, never thrown. */
export type PackageSubmitOutcome =
  | { endpoint: string; kind: 'result'; result: PackageSubmitResult }
  | { endpoint: string; kind: 'failed'; status: number; body: string };

/**
 * The node I/O a package broadcast needs. Esplora-compatible APIs (electrs)
 * expose all three; {@link esploraInscribeTransport} builds one from base URLs.
 */
export interface InscribeBroadcastTransport {
  /** Core `testmempoolaccept` over the whole package. Validates; sends nothing. */
  testPackage(hexes: readonly string[]): Promise<readonly PackageAcceptResult[]>;
  /** Core `submitpackage`. One outcome per endpoint the transport talks to. */
  submitPackage(hexes: readonly string[]): Promise<readonly PackageSubmitOutcome[]>;
  /** Core `sendrawtransaction` for one tx: resolves to its txid or rejects with the node's reason. */
  sendTransaction(hex: string): Promise<string>;
}

/** The signed pair plus what a recovery needs if only the commit gets out. */
export interface SignedCommitAndReveal {
  commitHex: string;
  revealHex: string;
  commitTxId: string;
  revealTxId: string;
  commitAddress: string;
  ephemeral: { privKey: Uint8Array; pubkeyXonly: Uint8Array };
}

/** Reveal resends after a submission that may have left the commit alone. */
const REVEAL_RESENDS = 3;

/** Core's reject reason for a transaction that is already in the mempool. */
const ALREADY_IN_MEMPOOL = 'txn-already-in-mempool';

/**
 * Validate, then send, the commit and reveal of one inscribe. Resolves once
 * both are in a mempool. Throws an {@link InscribeInputError} when nothing was
 * sent (`package-check-unavailable`, `package-rejected`,
 * `package-not-accepted`), and an {@link InscribeRevealPendingError} when the
 * commit may be out but the reveal could not be sent.
 */
export async function broadcastCommitAndReveal(
  transport: InscribeBroadcastTransport,
  pair: SignedCommitAndReveal,
): Promise<void> {
  const hexes = [pair.commitHex, pair.revealHex];

  let checks: readonly PackageAcceptResult[];
  try {
    checks = await transport.testPackage(hexes);
  } catch (err) {
    throw new InscribeInputError(
      'package-check-unavailable',
      `testmempoolaccept unavailable: ${errText(err)}`,
      'The network could not be reached to check the transactions. Nothing was sent and your funds were not touched; try again.',
    );
  }
  if (checks[0]?.['reject-reason'] === ALREADY_IN_MEMPOOL) {
    // An earlier attempt put the commit out; only the reveal is missing.
    return finishRevealAfterCommit(transport, pair);
  }
  const refused = checks.filter(c => c.allowed !== true);
  if (checks.length !== hexes.length || refused.length > 0) {
    const reasons = refused.map(c => c['reject-reason']).filter(Boolean).join('; ') || 'not validated';
    throw new InscribeInputError(
      'package-rejected',
      `testmempoolaccept refused the package: ${reasons}`,
      `The node would not accept these transactions (${reasons}), so nothing was sent and your funds were not touched.`,
      { checks },
    );
  }

  const outcomes = await transport.submitPackage(hexes);
  const state = packageState(outcomes, pair.commitTxId, pair.revealTxId);
  if (state === 'both') return;
  if (state === 'none') {
    throw new InscribeInputError(
      'package-not-accepted',
      `submitpackage accepted neither transaction: ${describeOutcomes(outcomes)}`,
      'The transactions passed the check but were not accepted when sent. Nothing went out and your funds were not touched; try again.',
      { outcomes },
    );
  }

  return resendReveal(transport, pair, describeOutcomes(outcomes));
}

/** The commit is already in the mempool: check the reveal alone, then send it. */
async function finishRevealAfterCommit(
  transport: InscribeBroadcastTransport,
  pair: SignedCommitAndReveal,
): Promise<void> {
  let check: PackageAcceptResult | undefined;
  try {
    [check] = await transport.testPackage([pair.revealHex]);
  } catch (err) {
    throw new InscribeRevealPendingError({ ...pair, reason: `commit already in mempool; reveal check unavailable: ${errText(err)}` });
  }
  if (check?.['reject-reason'] === ALREADY_IN_MEMPOOL) return;
  if (check?.allowed !== true) {
    throw new InscribeRevealPendingError({ ...pair, reason: check?.['reject-reason'] || 'reveal not validated' });
  }
  return resendReveal(transport, pair, 'commit already in mempool');
}

/** Send the signed reveal on its own, a few times, before handing out the recovery data. */
async function resendReveal(
  transport: InscribeBroadcastTransport,
  pair: SignedCommitAndReveal,
  reason: string,
): Promise<void> {
  let last = reason;
  for (let attempt = 0; attempt < REVEAL_RESENDS; attempt++) {
    try {
      await transport.sendTransaction(pair.revealHex);
      return;
    } catch (err) {
      last = errText(err);
    }
  }
  throw new InscribeRevealPendingError({ ...pair, reason: last });
}

/**
 * Where a submission left the pair. `none` only when every endpoint answered
 * and each refused the commit, so a request that failed in flight (and may
 * have been processed) never counts as "nothing sent".
 */
export function packageState(
  outcomes: readonly PackageSubmitOutcome[],
  commitTxId: string,
  revealTxId: string,
): 'both' | 'commit-only' | 'none' | 'unknown' {
  let commitIn = false;
  let revealIn = false;
  let allAnsweredCommitRefused = outcomes.length > 0;
  for (const o of outcomes) {
    if (o.kind !== 'result') {
      allAnsweredCommitRefused = false;
      continue;
    }
    if (o.result.package_msg === 'success') return 'both';
    const entries = Object.values(o.result['tx-results'] ?? {});
    const commit = entries.find(e => e.txid === commitTxId);
    const reveal = entries.find(e => e.txid === revealTxId);
    if (commit && !commit.error) commitIn = true;
    if (reveal && !reveal.error) revealIn = true;
    if (!commit || !commit.error) allAnsweredCommitRefused = false;
  }
  if (commitIn && revealIn) return 'both';
  if (commitIn) return 'commit-only';
  if (allAnsweredCommitRefused) return 'none';
  return 'unknown';
}

/** Options for {@link esploraInscribeTransport}. */
export interface EsploraInscribeTransportOptions {
  /** Per-request timeout in milliseconds. Default 15s. */
  timeoutMs?: number;
  /** For tests and environments without a global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * A transport over one or more Esplora-compatible base URLs (for example
 * `https://api.ordpool.space/api`). The dry run asks the endpoints in order
 * and uses the first answer; submission and resends go to all of them in
 * parallel, so the pair reaches more of the network at once.
 */
export function esploraInscribeTransport(
  endpoints: ReadonlyArray<string>,
  options: EsploraInscribeTransportOptions = {},
): InscribeBroadcastTransport {
  if (endpoints.length === 0) throw new Error('esploraInscribeTransport needs at least one endpoint');
  const bases = endpoints.map(e => e.replace(/\/+$/, ''));
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const post = async (url: string, body: string, contentType: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
        signal: controller.signal,
      });
      return { status: res.status, ok: res.ok, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async testPackage(hexes) {
      const failures: string[] = [];
      for (const base of bases) {
        try {
          const r = await post(`${base}/txs/test`, JSON.stringify(hexes), 'application/json');
          const parsed = r.ok ? parseJson(r.text) : undefined;
          if (Array.isArray(parsed)) return parsed as PackageAcceptResult[];
          failures.push(`${base}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
        } catch (err) {
          failures.push(`${base}: ${errText(err)}`);
        }
      }
      throw new Error(failures.join(' | '));
    },

    async submitPackage(hexes) {
      return Promise.all(bases.map(async (base): Promise<PackageSubmitOutcome> => {
        try {
          const r = await post(`${base}/txs/package`, JSON.stringify(hexes), 'application/json');
          if (r.ok) {
            const parsed = parseJson(r.text) as PackageSubmitResult | undefined;
            if (typeof parsed?.package_msg === 'string') return { endpoint: base, kind: 'result', result: parsed };
          }
          return { endpoint: base, kind: 'failed', status: r.status, body: r.text.slice(0, 500) };
        } catch (err) {
          return { endpoint: base, kind: 'failed', status: -1, body: errText(err) };
        }
      }));
    },

    async sendTransaction(hex) {
      const results = await Promise.all(bases.map(async base => {
        try {
          const r = await post(`${base}/tx`, hex, 'text/plain');
          return r.ok ? { txid: r.text.trim() } : { error: `${base}: HTTP ${r.status} ${r.text.slice(0, 200)}` };
        } catch (err) {
          return { error: `${base}: ${errText(err)}` };
        }
      }));
      const accepted = results.find((r): r is { txid: string } => 'txid' in r);
      if (accepted) return accepted.txid;
      throw new Error(results.map(r => ('error' in r ? r.error : '')).join(' | '));
    },
  };
}

function describeOutcomes(outcomes: readonly PackageSubmitOutcome[]): string {
  return outcomes.map(o => o.kind === 'result'
    ? `${o.endpoint}: ${o.result.package_msg} (${Object.values(o.result['tx-results'] ?? {})
      .map(e => `${e.txid.slice(0, 8)}${e.error ? ` ${e.error}` : ' ok'}`).join(', ')})`
    : `${o.endpoint}: HTTP ${o.status} ${o.body}`).join(' | ');
}

/** `JSON.parse` that returns `undefined` instead of throwing, so a bad body keeps its real status. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
