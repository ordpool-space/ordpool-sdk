#!/usr/bin/env node
/**
 * Machine-wide regtest stack slots (e2e/stack-slots.ts), for humans, agents,
 * workflows and the bootstrap scripts.
 *
 *   node scripts/e2e-slots.mjs list
 *       Every slot: number, prefix, owner pid, age, held or stale and why.
 *   node scripts/e2e-slots.mjs run [--kind regtest|consumer] [--label TEXT] -- <command> [args...]
 *       Acquire a slot (waiting in line), run the command with the slot's
 *       environment, then tear the slot's compose projects down and release it,
 *       on success, failure and Ctrl-C alike.
 *   node scripts/e2e-slots.mjs acquire [--kind K] [--owner-pid PID] [--label TEXT] [--format sh|github|json]
 *       Acquire a slot (waiting in line) held by PID (default: the parent of
 *       this process), print its environment. `--format sh` for
 *       `eval "$(...)"`, `github` for `>> "$GITHUB_ENV"`.
 *   node scripts/e2e-slots.mjs env --slot N [--kind K] [--format sh|github|json]
 *       Print slot N's environment without acquiring. `sh` keeps variables
 *       that are already set.
 *   node scripts/e2e-slots.mjs release N [--owner-pid PID]
 *       Release slot N (only when PID holds it, if given). Leaves containers alone.
 *   node scripts/e2e-slots.mjs down N [--force]
 *       Tear slot N's compose projects down and release it. Refused while the
 *       owner process still runs, unless --force. For YOUR OWN stacks only.
 *   node scripts/e2e-slots.mjs reclaim
 *       Remove every stale slot (owner gone, no container running).
 *
 * Environment: ORDPOOL_E2E_MAX_STACKS (how many stacks at once), ORDPOOL_E2E_SLOT_DIR
 * (slot directory, default ~/.ordpool-e2e/slots), ORDPOOL_E2E_SLOT_WAIT_MS (how long
 * to wait for a slot).
 *
 * It reads the compiled helpers in dist-e2e/, so it runs wherever the package
 * is installed, in this repo and in a consumer.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const slots = require('../dist-e2e/stack-slots.js');
const ports = require('../dist-e2e/stack-ports.js');

const USAGE = 'usage: node scripts/e2e-slots.mjs list | run [--kind K] [--label T] -- <cmd...> | acquire [--kind K] [--owner-pid PID] [--label T] [--format sh|github|json] | env --slot N [--kind K] [--format F] | release N [--owner-pid PID] | down N [--force] | reclaim';

/** Parses `--name value` and `--flag` options up to `--`; the rest are positional. */
function parseArgs(argv) {
  const opts = {};
  const positional = [];
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else positional.push(a);
  }
  return { opts, positional, rest };
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function intArg(value, name) {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 0) fail(`${name} must be a non-negative integer, got ${value}`);
  return n;
}

function kindArg(value) {
  const kind = value ?? 'regtest';
  if (kind !== 'regtest' && kind !== 'consumer') fail(`--kind must be regtest or consumer, got ${kind}`);
  return kind;
}

/** Prints `env` as shell exports, GitHub env lines or JSON. */
function printEnv(env, format, keepSet) {
  const keys = Object.keys(env).sort();
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
  } else if (format === 'github') {
    for (const k of keys) process.stdout.write(`${k}=${env[k]}\n`);
  } else if (format === 'sh') {
    for (const k of keys) {
      process.stdout.write(keepSet ? `export ${k}="\${${k}:-${env[k]}}"\n` : `export ${k}=${env[k]}\n`);
    }
  } else {
    fail(`--format must be sh, github or json, got ${format}`);
  }
}

const log = (line) => console.error(line);

function wait() {
  return { waitMs: slots.slotWaitMs(), log };
}

async function main() {
  const [command = 'list', ...argv] = process.argv.slice(2);
  const { opts, positional, rest } = parseArgs(argv);
  const root = slots.slotRoot();

  switch (command) {
    case 'list': {
      const all = slots.listSlots(root);
      console.log(`slot directory ${root}, ${slots.MAX_STACKS_ENV}=${slots.maxStacks()}`);
      if (all.length === 0) {
        console.log('no slot held');
        break;
      }
      for (const s of all) {
        const r = s.record;
        const ports = r ? `electrs :${r.ports.electrs}, bitcoind :${r.ports.bitcoindRpc}, ord :${r.ports.ord}` : '';
        console.log(`slot ${s.slot}  ${s.state.padEnd(5)}  ${r ? r.prefix : '-'}  pid ${r ? r.ownerPid : '-'}  ${slots.formatAge(s.ageMs)} old  ${ports}${r && r.label ? `  (${r.label})` : ''}`);
        console.log(`        ${s.reason}`);
      }
      break;
    }
    case 'acquire': {
      const kind = kindArg(opts.kind);
      const ownerPid = opts['owner-pid'] === undefined ? process.ppid : intArg(opts['owner-pid'], '--owner-pid');
      const record = await slots.acquireSlot(
        { root, max: slots.maxStacks(), ownerPid, kind, label: opts.label ?? '' },
        wait(),
      );
      log(`acquired slot ${record.slot} (${record.prefix}) for pid ${ownerPid}`);
      printEnv(ports.slotEnv(record.slot, kind), opts.format ?? 'sh', false);
      break;
    }
    case 'env': {
      const slot = intArg(opts.slot, '--slot');
      printEnv(ports.slotEnv(slot, kindArg(opts.kind)), opts.format ?? 'sh', true);
      break;
    }
    case 'release': {
      const slot = intArg(positional[0], 'slot');
      slots.releaseSlot(root, slot, opts['owner-pid'] === undefined ? undefined : intArg(opts['owner-pid'], '--owner-pid'));
      log(`released slot ${slot}`);
      break;
    }
    case 'down': {
      const slot = intArg(positional[0], 'slot');
      const status = slots.slotStatus(root, slot);
      const record = status?.record ?? null;
      if (!record) fail(`slot ${slot} has no owner record; nothing to tear down`);
      if (!opts.force && slots.defaultSlotIo.isOwnerAlive(record.ownerPid, record.ownerStartedAt)) {
        fail(`slot ${slot} (${record.prefix}) is held by pid ${record.ownerPid}, which still runs. Pass --force only if that run is yours.`);
      }
      slots.composeDown(record);
      slots.releaseSlot(root, slot);
      log(`slot ${slot} (${record.prefix}) torn down and released`);
      break;
    }
    case 'reclaim': {
      const freed = slots.reclaimStaleSlots(root);
      log(freed.length === 0 ? 'no stale slot' : `reclaimed slot ${freed.join(', ')}`);
      break;
    }
    case 'run': {
      if (rest.length === 0) fail(USAGE);
      const code = await slots.runInSlot({
        root,
        max: slots.maxStacks(),
        ownerPid: process.pid,
        kind: kindArg(opts.kind),
        label: opts.label ?? rest.join(' ').slice(0, 80),
        command: rest[0],
        args: rest.slice(1),
        wait: wait(),
        // From here Ctrl-C goes to the command, and the teardown follows it.
        onAcquired: () => process.off('SIGINT', leaveQueue),
      });
      process.exit(code);
      break;
    }
    default:
      fail(USAGE);
  }
}

/** Ctrl-C while waiting in line: nothing is held yet, so leave at once. */
function leaveQueue() {
  process.exit(130);
}
process.on('SIGINT', leaveQueue);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
