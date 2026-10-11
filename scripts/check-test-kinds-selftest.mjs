#!/usr/bin/env node
/**
 * The test-contract checker is code, so it proves itself like any other code:
 * a gate that cannot fail is not evidence. This runs `check-test-kinds.mjs`
 * as a subprocess over its probes and asserts the exact set of findings.
 *
 *   probes/fail/**   each file triggers exactly the one rule its name says
 *   probes/pass/**   the allowed forms; any finding here is a false positive
 *   probes/upstream  violations inside an upstream scope; skipped, never reported
 *   bad-scope/       a scope entry without a reason; the run must fail in every mode
 *
 * The probes live in `check-test-kinds.selftest/`, which the checker skips
 * unless it is pointed at a directory inside it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSITIONAL_TIMEOUT_ARGS, RULE_IDS, callArgs, lex } from './check-test-kinds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, 'check-test-kinds.mjs');
const PROBES = join(HERE, 'check-test-kinds.selftest', 'probes');
const BAD_SCOPE = join(HERE, 'check-test-kinds.selftest', 'bad-scope');
const REPO = join(HERE, '..');

/** `file  rule`, one line per expected finding. Duplicates count. */
const EXPECTED = [
  'test-kinds.json  scope-unused',
  'fail/header-missing-fakes.spec.ts  header-missing',
  'fail/e2e/chain/header-missing.chain.spec.ts  header-missing',
  'fail/header-incomplete.spec.ts  header-incomplete',
  'fail/header-incomplete-empty-field.spec.ts  header-incomplete',
  'fail/kind-mismatch-header-and-playwright.spec.ts  kind-mismatch',
  'fail/e2e/chain/kind-mismatch.chain.spec.ts  kind-mismatch',
  'fail/kind-mismatch-playwright.spec.ts  kind-mismatch',
  'fail/kind-location.chain.spec.ts  kind-location',
  'fail/e2e/kind-location-unit-under-e2e.spec.ts  kind-location',
  'fail/kind-word.integration.spec.ts  kind-word',
  'fail/retries-configure.spec.ts  retries',
  'fail/playwright.config.ts  retries',
  'fail/fixed-wait-wait-for-timeout.spec.ts  fixed-wait',
  'fail/fixed-wait-promise.spec.ts  fixed-wait',
  'fail/fixed-wait-sleep-in-test-generator-loop.spec.ts  fixed-wait',
  'fail/force-click.spec.ts  force-click',
  'fail/force-click-evaluate.spec.ts  force-click',
  'fail/async-wait-predicate.spec.ts  async-wait-predicate',
  'fail/swallowed-catch.spec.ts  swallowed-catch',
  'fail/swallowed-catch-try.spec.ts  swallowed-catch',
  'fail/spec-timeout.spec.ts  spec-timeout',
  'fail/spec-timeout-jest-arg.spec.ts  spec-timeout',
  'fail/spec-timeout-named-key.spec.ts  spec-timeout',
  'fail/spec-timeout-literal-key.spec.ts  spec-timeout',
  'fail/optional-wait-optional-popup.spec.ts  optional-wait',
  'fail/optional-wait-is-visible-within.spec.ts  optional-wait',
  // a swallowed wait is both a swallowed failure and a wait that hopes nothing happens
  'fail/optional-wait-catch.spec.ts  optional-wait',
  'fail/optional-wait-catch.spec.ts  swallowed-catch',
  'fail/optional-wait-try.spec.ts  optional-wait',
  'fail/optional-wait-try.spec.ts  swallowed-catch',
  'fail/workaround-without-reason-short.spec.ts  workaround-without-reason',
  'fail/workaround-without-reason-missing.spec.ts  workaround-without-reason',
  'fail/workaround-without-reason-variable.spec.ts  workaround-without-reason',
  'fail/e2e/real-host.e2e.spec.ts  real-host',
  'fail/real-host-unit-fetch.spec.ts  real-host',
  'fail/sdk-module-mock.spec.ts  sdk-module-mock',
];

const problems = [];
const run = (args) => spawnSync(process.execPath, [CHECKER, ...args], { encoding: 'utf8' });

// 1. Default mode over the probes: exit 1 and exactly the expected findings.
const gate = run([PROBES]);
if (gate.status !== 1) problems.push(`default mode over the probes exited ${gate.status}, expected 1`);
const actual = gate.stdout
  .split('\n')
  .map((l) => /^(.+?):\d+  ([a-z-]+)  /.exec(l))
  .filter((m) => m !== null)
  .map((m) => `${m[1]}  ${m[2]}`);
const count = (list) => list.reduce((acc, k) => acc.set(k, (acc.get(k) ?? 0) + 1), new Map());
const want = count(EXPECTED);
const got = count(actual);
for (const key of new Set([...want.keys(), ...got.keys()])) {
  const w = want.get(key) ?? 0;
  const g = got.get(key) ?? 0;
  if (w !== g) problems.push(`${key}: expected ${w}, reported ${g}`);
}

// 2. Every rule has a should-fail probe, so a detector that stops firing reds this run.
for (const rule of RULE_IDS) {
  if (!EXPECTED.some((e) => e.endsWith(`  ${rule}`))) problems.push(`rule ${rule} has no should-fail probe`);
}

// 3. Report mode: exit 0, the upstream file listed as skipped with its reason.
const report = run(['--report', PROBES]);
if (report.status !== 0) problems.push(`--report over the probes exited ${report.status}, expected 0`);
if (!report.stdout.includes('upstream/mempool/mainnet.spec.ts  upstream, skipped (mempool upstream, kept byte-identical for merges)')) {
  problems.push('--report does not list upstream/mempool/mainnet.spec.ts as skipped with its reason');
}
// Four calls in the probes: one with a reason (pass/workaround), three without.
if (!report.stdout.includes('sanctioned workarounds (workaroundWaitForTimeout): 4 (3 without a valid reason)')) {
  problems.push('--report does not count the 4 workaroundWaitForTimeout calls in the probes');
}

// 4. A scope entry without a reason fails the run in both modes.
for (const args of [[BAD_SCOPE], ['--report', BAD_SCOPE]]) {
  const r = run(args);
  if (r.status !== 1 || !r.stderr.includes('"reason" must be a non-empty string')) {
    problems.push(`${args.join(' ')}: expected exit 1 with a missing-reason error, got exit ${r.status}: ${r.stderr.trim()}`);
  }
}

// 5. A run on the repo itself never enters the probe directory.
const repo = run(['--report', REPO]);
if (repo.status !== 0) problems.push(`--report over the repo exited ${repo.status}`);
if (repo.stdout.includes('check-test-kinds.selftest')) problems.push('a run on the repo reported files inside check-test-kinds.selftest/');

// 6. No exported e2e helper takes a timeout parameter: the bound is the runner
//    config's, read through e2eTimeoutMs. POSITIONAL_TIMEOUT_ARGS, empty, still
//    has to match the signatures of whatever it lists.
const e2eFiles = [];
const walkTs = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'node_modules' && name !== 'extensions') walkTs(full); }
    else if (name.endsWith('.ts') && !/\.(spec|test)\.ts$|\.d\.ts$/.test(name)) e2eFiles.push(full);
  }
};
walkTs(join(REPO, 'e2e'));
const signatures = new Map();
for (const file of e2eFiles) {
  const src = readFileSync(file, 'utf8');
  const { code } = lex(src);
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([\w$]+)\s*(?:<[^>(]*>)?\s*\(/g)) {
    const { args } = callArgs(code, m.index + m[0].length - 1);
    signatures.set(m[1], args.map((a) => code.slice(a.start, a.end).trim().split(/[\s=:?]/)[0]));
    // An options object declared inline carries its bound as a member.
    for (const a of args) {
      const member = /\b(\w*[tT]imeout\w*)\??\s*:/.exec(code.slice(a.start, a.end));
      if (member) problems.push(`${m[1]} takes a timeout option \`${member[1]}\`; e2e helpers read the one global bound (e2eTimeoutMs) instead`);
    }
  }
}
for (const [helper, index] of Object.entries(POSITIONAL_TIMEOUT_ARGS)) {
  const params = signatures.get(helper);
  if (!params) problems.push(`POSITIONAL_TIMEOUT_ARGS lists ${helper}, which no file under e2e/ exports`);
  else if (!/timeout/i.test(params[index] ?? '')) problems.push(`POSITIONAL_TIMEOUT_ARGS: ${helper} parameter ${index} is "${params[index]}", not a timeout`);
}
for (const [helper, params] of signatures) {
  const at = params.findIndex((p) => /timeout/i.test(p));
  if (at !== -1) problems.push(`${helper} takes a timeout parameter at ${at}; e2e helpers read the one global bound (e2eTimeoutMs) instead`);
}

if (problems.length) {
  console.error('check-test-kinds selftest FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nchecker output over the probes:\n' + gate.stdout + gate.stderr);
  process.exit(1);
}
console.log(`check-test-kinds selftest OK: ${EXPECTED.length} expected findings over ${RULE_IDS.length} rules, 0 false positives, scope and reason checks hold.`);
