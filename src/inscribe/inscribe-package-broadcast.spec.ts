/**
 * `broadcastCommitAndReveal`: validate the pair, send it, recover a commit
 * that lands alone. Every outcome the function names is pinned here.
 *
 * The node answers use the shapes ordpool-electrs returns for `POST /txs/test`
 * and `POST /txs/package`, as bitcoind v30.2 produced them on regtest for a
 * parent P (34958184…) and a child C (e71ff0ce…) paying no fee: `allowed` is
 * `null` for P because C failed first, and `submitpackage` kept P alone while
 * answering HTTP 200.
 */
import { describe, expect, it } from '@jest/globals';

import { InscribeInputError, InscribeRevealPendingError } from './inscribe-errors.js';
import {
  InscribeBroadcastTransport,
  PackageAcceptResult,
  PackageSubmitOutcome,
  SignedCommitAndReveal,
  broadcastCommitAndReveal,
  esploraInscribeTransport,
  packageState,
} from './inscribe-package-broadcast.js';

const COMMIT_TXID = '34958184fcdfa5bffd0eec0d2fa83c738b108e441744fe771e8c64f5ce74188b';
const REVEAL_TXID = 'e71ff0ced3838ace36e87e616831ee041de911920dfafc58800abbdffbfdda74';

const PAIR: SignedCommitAndReveal = {
  commitHex: 'c0',
  revealHex: 'e7',
  commitTxId: COMMIT_TXID,
  revealTxId: REVEAL_TXID,
  commitAddress: 'bcrt1pcommit',
  ephemeral: { privKey: new Uint8Array(32).fill(7), pubkeyXonly: new Uint8Array(32).fill(8) },
};

const BOTH_ALLOWED: PackageAcceptResult[] = [
  { txid: COMMIT_TXID, allowed: true, 'reject-reason': null },
  { txid: REVEAL_TXID, allowed: true, 'reject-reason': null },
];
const REVEAL_REFUSED: PackageAcceptResult[] = [
  { txid: COMMIT_TXID, allowed: null, 'reject-reason': null },
  { txid: REVEAL_TXID, allowed: false, 'reject-reason': 'min relay fee not met' },
];

const result = (packageMsg: string, commitError: string | null, revealError: string | null): PackageSubmitOutcome => ({
  endpoint: 'https://api.example',
  kind: 'result',
  result: {
    package_msg: packageMsg,
    'tx-results': {
      w1: { txid: COMMIT_TXID, error: commitError },
      w2: { txid: REVEAL_TXID, error: revealError },
    },
  },
});
const SUCCESS = result('success', null, null);
const COMMIT_ONLY = result('transaction failed', null, 'min relay fee not met, 0 < 12');
const NEITHER = result('transaction failed', 'bad-txns-inputs-missingorspent', 'bad-txns-inputs-missingorspent');
const NETWORK_FAILED: PackageSubmitOutcome = { endpoint: 'https://api.example', kind: 'failed', status: -1, body: 'ECONNRESET' };

/** A scripted transport that logs every call, in order, with its argument. */
function scripted(script: {
  test?: () => Promise<readonly PackageAcceptResult[]>;
  submit?: () => Promise<readonly PackageSubmitOutcome[]>;
  send?: (attempt: number) => Promise<string>;
}): InscribeBroadcastTransport & { log: string[] } {
  const log: string[] = [];
  let sends = 0;
  return {
    log,
    testPackage: async (hexes) => { log.push(`test ${hexes.join(',')}`); return (script.test ?? (async () => BOTH_ALLOWED))(); },
    submitPackage: async (hexes) => { log.push(`submit ${hexes.join(',')}`); return (script.submit ?? (async () => [SUCCESS]))(); },
    sendTransaction: async (h) => { log.push(`send ${h}`); return (script.send ?? (async () => REVEAL_TXID))(++sends); },
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof InscribeInputError ? err.code : `other: ${String(err)}`;
  }
}

describe('broadcastCommitAndReveal', () => {
  it('validates the pair, then sends it as one package, commit first', async () => {
    const t = scripted({});
    await broadcastCommitAndReveal(t, PAIR);
    expect(t.log).toEqual(['test c0,e7', 'submit c0,e7']);
  });

  it('sends nothing when testmempoolaccept refuses the reveal, and says why', async () => {
    const t = scripted({ test: async () => REVEAL_REFUSED });
    const err = await broadcastCommitAndReveal(t, PAIR).catch(e => e);
    expect(err).toBeInstanceOf(InscribeInputError);
    expect(err.code).toBe('package-rejected');
    expect(err.message).toBe('testmempoolaccept refused the package: min relay fee not met');
    expect(t.log).toEqual(['test c0,e7']);
  });

  it('treats allowed:null as refused: a transaction Core did not finish validating is not accepted', async () => {
    const t = scripted({
      test: async () => [
        { txid: COMMIT_TXID, allowed: null, 'reject-reason': null },
        { txid: REVEAL_TXID, allowed: true, 'reject-reason': null },
      ],
    });
    expect(await codeOf(broadcastCommitAndReveal(t, PAIR))).toBe('package-rejected');
    expect(t.log).toEqual(['test c0,e7']);
  });

  it('refuses a dry run that answered for fewer transactions than were sent', async () => {
    const t = scripted({ test: async () => [BOTH_ALLOWED[0]] });
    expect(await codeOf(broadcastCommitAndReveal(t, PAIR))).toBe('package-rejected');
    expect(t.log).toEqual(['test c0,e7']);
  });

  it('sends nothing when the dry run cannot be reached', async () => {
    const t = scripted({ test: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await codeOf(broadcastCommitAndReveal(t, PAIR))).toBe('package-check-unavailable');
    expect(t.log).toEqual(['test c0,e7']);
  });

  it('sends the signed reveal on its own when the package left the commit alone', async () => {
    const t = scripted({ submit: async () => [COMMIT_ONLY] });
    await broadcastCommitAndReveal(t, PAIR);
    expect(t.log).toEqual(['test c0,e7', 'submit c0,e7', 'send e7']);
  });

  it('keeps resending the reveal and succeeds on a later attempt', async () => {
    const t = scripted({
      submit: async () => [COMMIT_ONLY],
      send: async (attempt) => { if (attempt < 3) throw new Error('timeout'); return REVEAL_TXID; },
    });
    await broadcastCommitAndReveal(t, PAIR);
    expect(t.log).toEqual(['test c0,e7', 'submit c0,e7', 'send e7', 'send e7', 'send e7']);
  });

  it('hands out the recovery data when the reveal cannot be sent after the commit landed', async () => {
    const t = scripted({
      submit: async () => [COMMIT_ONLY],
      send: async () => { throw new Error('min relay fee not met, 0 < 12'); },
    });
    const err = await broadcastCommitAndReveal(t, PAIR).catch(e => e);
    expect(err).toBeInstanceOf(InscribeRevealPendingError);
    expect(err.code).toBe('reveal-pending');
    expect(err.commitTxId).toBe(COMMIT_TXID);
    expect(err.revealTxId).toBe(REVEAL_TXID);
    expect(err.revealHex).toBe('e7');
    expect(err.commitAddress).toBe('bcrt1pcommit');
    expect(err.ephemeral.privKey).toBe(PAIR.ephemeral.privKey);
    expect(err.details).toEqual({ commitTxId: COMMIT_TXID, revealTxId: REVEAL_TXID, reason: 'min relay fee not met, 0 < 12' });
    expect(t.log).toEqual(['test c0,e7', 'submit c0,e7', 'send e7', 'send e7', 'send e7']);
  });

  it('does not resend when every endpoint refused the commit too: nothing went out', async () => {
    const t = scripted({ submit: async () => [NEITHER] });
    expect(await codeOf(broadcastCommitAndReveal(t, PAIR))).toBe('package-not-accepted');
    expect(t.log).toEqual(['test c0,e7', 'submit c0,e7']);
  });

  it('treats a submission that failed in flight as possibly sent, and resends the reveal', async () => {
    const t = scripted({ submit: async () => [NETWORK_FAILED] });
    await broadcastCommitAndReveal(t, PAIR);
    expect(t.log).toEqual(['test c0,e7', 'submit c0,e7', 'send e7']);
  });
});

describe('broadcastCommitAndReveal, retrying after the commit already went out', () => {
  // bitcoind v30.2 with the parent already in its mempool and a valid child:
  // testmempoolaccept refuses the parent and skips the child.
  const COMMIT_ALREADY_IN: PackageAcceptResult[] = [
    { txid: COMMIT_TXID, allowed: false, 'reject-reason': 'txn-already-in-mempool' },
    { txid: REVEAL_TXID, allowed: null, 'reject-reason': null },
  ];

  it('checks and sends the reveal alone, without resubmitting the package', async () => {
    let tests = 0;
    const t = scripted({
      test: async () => (++tests === 1 ? COMMIT_ALREADY_IN : [{ txid: REVEAL_TXID, allowed: true, 'reject-reason': null }]),
    });
    await broadcastCommitAndReveal(t, PAIR);
    expect(t.log).toEqual(['test c0,e7', 'test e7', 'send e7']);
  });

  it('is done when the reveal is already in the mempool too', async () => {
    let tests = 0;
    const t = scripted({
      test: async () => (++tests === 1 ? COMMIT_ALREADY_IN : [{ txid: REVEAL_TXID, allowed: false, 'reject-reason': 'txn-already-in-mempool' }]),
    });
    await broadcastCommitAndReveal(t, PAIR);
    expect(t.log).toEqual(['test c0,e7', 'test e7']);
  });

  it('hands out the recovery data when the reveal is refused on its own', async () => {
    let tests = 0;
    const t = scripted({
      test: async () => (++tests === 1 ? COMMIT_ALREADY_IN : [{ txid: REVEAL_TXID, allowed: false, 'reject-reason': 'mandatory-script-verify-flag-failed' }]),
    });
    const err = await broadcastCommitAndReveal(t, PAIR).catch(e => e);
    expect(err).toBeInstanceOf(InscribeRevealPendingError);
    expect(err.details.reason).toBe('mandatory-script-verify-flag-failed');
    expect(t.log).toEqual(['test c0,e7', 'test e7']);
  });
});

describe('packageState', () => {
  it('is both when any endpoint reports success, whatever the others say', () => {
    expect(packageState([NETWORK_FAILED, SUCCESS], COMMIT_TXID, REVEAL_TXID)).toBe('both');
  });
  it('is commit-only for the shape bitcoind returns when the child fails', () => {
    expect(packageState([COMMIT_ONLY], COMMIT_TXID, REVEAL_TXID)).toBe('commit-only');
  });
  it('is none only when every endpoint answered and refused the commit', () => {
    expect(packageState([NEITHER, NEITHER], COMMIT_TXID, REVEAL_TXID)).toBe('none');
  });
  it('is unknown when one endpoint refused and another failed in flight', () => {
    expect(packageState([NEITHER, NETWORK_FAILED], COMMIT_TXID, REVEAL_TXID)).toBe('unknown');
  });
  it('is unknown with no answer at all', () => {
    expect(packageState([], COMMIT_TXID, REVEAL_TXID)).toBe('unknown');
  });
  it('is both when the entries show both accepted although package_msg is not success', () => {
    expect(packageState([result('transaction failed', null, null)], COMMIT_TXID, REVEAL_TXID)).toBe('both');
  });
});

describe('esploraInscribeTransport', () => {
  type Reply = { status: number; body: string } | Error;
  function fakeFetch(replies: Record<string, Reply>, seen: string[]): typeof fetch {
    return (async (url: unknown, init?: RequestInit) => {
      seen.push(`${init?.method} ${String(url)} ${(init?.headers as Record<string, string>)['content-type']} ${String(init?.body)}`);
      const r = replies[String(url)];
      if (!r) throw new Error(`unmocked ${String(url)}`);
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body } as Response;
    }) as unknown as typeof fetch;
  }

  it('asks the dry-run endpoints in order and uses the first that answers', async () => {
    const seen: string[] = [];
    const t = esploraInscribeTransport(['https://a.example/api/', 'https://b.example/api'], {
      fetchImpl: fakeFetch({
        'https://a.example/api/txs/test': new Error('ECONNREFUSED'),
        'https://b.example/api/txs/test': { status: 200, body: JSON.stringify(REVEAL_REFUSED) },
      }, seen),
    });
    expect(await t.testPackage(['c0', 'e7'])).toEqual(REVEAL_REFUSED);
    expect(seen).toEqual([
      'POST https://a.example/api/txs/test application/json ["c0","e7"]',
      'POST https://b.example/api/txs/test application/json ["c0","e7"]',
    ]);
  });

  it('does not take a 200 that is not a result list as a dry-run answer', async () => {
    const t = esploraInscribeTransport(['https://a.example'], {
      fetchImpl: fakeFetch({ 'https://a.example/txs/test': { status: 200, body: '{"error":"maintenance"}' } }, []),
    });
    await expect(t.testPackage(['c0'])).rejects.toThrow('https://a.example: HTTP 200 {"error":"maintenance"}');
  });

  it('rejects the dry run when no endpoint answers, naming each failure', async () => {
    const t = esploraInscribeTransport(['https://a.example'], {
      fetchImpl: fakeFetch({ 'https://a.example/txs/test': { status: 400, body: 'Invalid transaction size for item 0' } }, []),
    });
    await expect(t.testPackage(['00'])).rejects.toThrow('https://a.example: HTTP 400 Invalid transaction size for item 0');
  });

  it('submits to every endpoint and reads package_msg from a 200, not the status', async () => {
    const seen: string[] = [];
    const t = esploraInscribeTransport(['https://a.example', 'https://b.example'], {
      fetchImpl: fakeFetch({
        'https://a.example/txs/package': { status: 200, body: JSON.stringify(COMMIT_ONLY.kind === 'result' ? COMMIT_ONLY.result : null) },
        'https://b.example/txs/package': { status: 200, body: 'not json' },
      }, seen),
    });
    const outcomes = await t.submitPackage(['c0', 'e7']);
    expect(outcomes).toEqual([
      { endpoint: 'https://a.example', kind: 'result', result: (COMMIT_ONLY as { result: unknown }).result },
      { endpoint: 'https://b.example', kind: 'failed', status: 200, body: 'not json' },
    ]);
    expect(packageState(outcomes, COMMIT_TXID, REVEAL_TXID)).toBe('commit-only');
    expect(seen).toEqual([
      'POST https://a.example/txs/package application/json ["c0","e7"]',
      'POST https://b.example/txs/package application/json ["c0","e7"]',
    ]);
  });

  it('sends one transaction as text to /tx and resolves with the first txid an endpoint returns', async () => {
    const seen: string[] = [];
    const t = esploraInscribeTransport(['https://a.example', 'https://b.example'], {
      fetchImpl: fakeFetch({
        'https://a.example/tx': { status: 400, body: 'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}' },
        'https://b.example/tx': { status: 200, body: `${REVEAL_TXID}\n` },
      }, seen),
    });
    expect(await t.sendTransaction('e7')).toBe(REVEAL_TXID);
    expect(seen).toEqual(['POST https://a.example/tx text/plain e7', 'POST https://b.example/tx text/plain e7']);
  });

  it('rejects a send that no endpoint accepted', async () => {
    const t = esploraInscribeTransport(['https://a.example'], {
      fetchImpl: fakeFetch({ 'https://a.example/tx': { status: 400, body: 'min relay fee not met' } }, []),
    });
    await expect(t.sendTransaction('e7')).rejects.toThrow('https://a.example: HTTP 400 min relay fee not met');
  });

  it('refuses to exist without an endpoint', () => {
    expect(() => esploraInscribeTransport([])).toThrow('esploraInscribeTransport needs at least one endpoint');
  });
});
