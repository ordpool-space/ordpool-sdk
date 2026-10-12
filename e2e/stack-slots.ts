/**
 * Machine-wide slots for regtest stacks: at most `ORDPOOL_E2E_MAX_STACKS`
 * stacks run on one machine at a time, whichever session, repo or process
 * starts them.
 *
 * A slot is a directory `<root>/slot-<N>` (root: `ORDPOOL_E2E_SLOT_DIR`, default
 * `~/.ordpool-e2e/slots`). `mkdir` is atomic, so two processes racing for slot N
 * cannot both create it: the one that does holds it, the other moves on. The
 * holder writes `owner.json` (owner PID, start time, prefix, ports) into it.
 * Slot N gives the stack its ports and prefix (`stack-ports.ts`).
 *
 * A slot is held while its owner process lives OR its compose projects have a
 * running container. The second condition is what keeps a stack's ports
 * reserved after the bootstrap that started it has exited, and frees the slot
 * once the stack is torn down. Only a slot that meets neither is stale, and
 * the next acquirer reclaims it.
 *
 * The CLI is `scripts/e2e-slots.mjs`; the bootstrap scripts reach it through
 * `e2e/stack-slot.sh`.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_SLOTS_SUPPORTED,
  slotEnv,
  slotPorts,
  slotPrefix,
  stackProjects,
  stackServices,
  type StackKind,
  type StackService,
} from './stack-ports';

/** Sets how many stacks may run on this machine at once. */
export const MAX_STACKS_ENV = 'ORDPOOL_E2E_MAX_STACKS';
/** Overrides the slot directory. */
export const SLOT_DIR_ENV = 'ORDPOOL_E2E_SLOT_DIR';
/** Overrides how long `acquireSlot` waits for a free slot, in milliseconds. */
export const SLOT_WAIT_ENV = 'ORDPOOL_E2E_SLOT_WAIT_MS';

/**
 * The default for `ORDPOOL_E2E_MAX_STACKS`: one stack per machine.
 *
 * Measured on 2026-10-12 on the Mac mini (32 GiB, colima VM 4 GiB / 4 CPUs,
 * 3904 MiB visible to the guest), one stack from `docker-compose.regtest.yml`
 * with every profile, images already built. Containers: `docker stats
 * --no-stream`, idle = 60 s after every service answered, load = sampled
 * every 2 s through a chain lane (core-flows-roundtrip,
 * inscribe-ord-indexing-roundtrip, funding-safety-classify: 10 tests, 123 s):
 *
 * | MiB | bitcoind | electrs | cat21-ord | ord-stock | ordpool-backend | stack |
 * |---|---|---|---|---|---|---|
 * | idle | 46.9 | 6.0 | 15.7 | 21.8 | 159.7 | 250.1 |
 * | load, peak | 50.8 | 7.3 | 19.4 | 35.9 | 160.2 | 254.1 |
 *
 * Inside the VM before the stack (`free -m`): 1637 MiB used, 2266 MiB
 * available; with the stack idle 1855 used. Host side of a wallet lane (RSS
 * summed over each process tree, shared pages counted per process): a headed
 * Chromium with a wallet extension on the harness page, 1055 MiB in 8
 * processes; the harness server 50 MiB; the Playwright driver 163 to 189 MiB.
 * The host at the same time: 19.9 GiB RSS summed over all processes, swap
 * 9.6 of 11.3 GiB in use, with no lane running.
 *
 * Derivation: the VM is not the limit while a stack runs: two stacks (2 x 254
 * MiB on top of 1637) take 2145 of 3904 MiB. The host is: it already swaps
 * with no lane running, and each lane adds about 1.3 GiB of browser, harness
 * and driver, all of which goes to swap; the 1.7 GiB of swap left covers one
 * such lane, not two. Hence 1. Not measured: building the Rust images
 * (electrs, cat21-ord) inside the VM, which a slot needs on its first stack.
 * A machine with more room sets `ORDPOOL_E2E_MAX_STACKS`.
 */
export const DEFAULT_MAX_STACKS = 1;

/**
 * The default bound of the wait for a slot: 40 minutes, the job cap of the
 * longest lane that holds a stack (`timeout-minutes: 40` of the wallet matrix
 * in `.github/workflows/e2e-playwright.yml`, which covers a cold xverse shard).
 * A slot that stays held longer than the longest lane may run is not a queue
 * any more; it is a stack nobody tore down, and waiting longer cannot help.
 */
export const DEFAULT_SLOT_WAIT_MS = 40 * 60_000;

/** How often a waiting acquirer looks again. */
export const SLOT_POLL_MS = 5_000;

/** How often a waiting acquirer repeats who holds the slots when nothing changed. */
export const SLOT_HEARTBEAT_MS = 60_000;

/**
 * How long a slot directory may exist without `owner.json` before it counts as
 * abandoned. An acquirer writes the record right after one port probe of its
 * slot (every probe a loopback connect, answered at once); a directory still
 * without a record after a minute was left by an acquirer that died between
 * the two steps.
 */
export const RECORD_GRACE_MS = 60_000;

/**
 * Bound of one port probe. A loopback connect is refused or accepted at once;
 * a probe that hangs counts as a port in use.
 */
export const PORT_PROBE_MS = 1_000;

/** What `owner.json` holds. */
export interface SlotRecord {
  slot: number;
  /** The process whose life holds the slot (besides running containers). */
  ownerPid: number;
  /** `ps -o lstart=` of the owner when it acquired, to tell a reused PID from the owner. */
  ownerStartedAt: string | null;
  /** ISO time of the acquisition. */
  acquiredAt: string;
  prefix: string;
  kind: StackKind;
  /** The compose projects a stack in this slot creates. */
  projects: string[];
  ports: Record<StackService, number>;
  /** Free text naming who acquired, for the list. */
  label: string;
}

export type SlotState = 'held' | 'stale';

export interface SlotStatus {
  slot: number;
  record: SlotRecord | null;
  state: SlotState;
  /** Why the slot is held or stale, one line. */
  reason: string;
  /** Milliseconds since the acquisition (or since the directory appeared, without a record). */
  ageMs: number;
}

/** The side effects of the allocator, replaceable in a unit spec. */
export interface SlotIo {
  /** Whether `pid` runs and, when `startedAt` is given, is still the process that started then. */
  isOwnerAlive(pid: number, startedAt: string | null): boolean;
  /** `ps -o lstart=` of `pid`, null when it does not run or `ps` cannot tell. */
  processStartTime(pid: number): string | null;
  /** The compose projects with at least one running container. Throws when docker does not answer. */
  runningProjects(): Set<string>;
  /** Whether something accepts connections on 127.0.0.1:`port`. */
  portInUse(port: number): Promise<boolean>;
  now(): number;
}

/** The slot directory: `ORDPOOL_E2E_SLOT_DIR`, else `~/.ordpool-e2e/slots`. */
export function slotRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[SLOT_DIR_ENV] || path.join(os.homedir(), '.ordpool-e2e', 'slots');
}

/** `ORDPOOL_E2E_MAX_STACKS`, else {@link DEFAULT_MAX_STACKS}. Throws on a value the port layout cannot serve. */
export function maxStacks(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_STACKS_ENV];
  if (raw === undefined || raw === '') return DEFAULT_MAX_STACKS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SLOTS_SUPPORTED) {
    throw new Error(`${MAX_STACKS_ENV}=${raw} must be an integer from 1 to ${MAX_SLOTS_SUPPORTED}`);
  }
  return n;
}

/** `ORDPOOL_E2E_SLOT_WAIT_MS`, else {@link DEFAULT_SLOT_WAIT_MS}. */
export function slotWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SLOT_WAIT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SLOT_WAIT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${SLOT_WAIT_ENV}=${raw} must be a non-negative integer`);
  return n;
}

function slotDir(root: string, slot: number): string {
  return path.join(root, `slot-${slot}`);
}

function recordPath(root: string, slot: number): string {
  return path.join(slotDir(root, slot), 'owner.json');
}

function readRecord(root: string, slot: number): SlotRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(root, slot), 'utf8')) as SlotRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The real side effects: `kill -0`, `ps`, `docker ps`, a loopback connect. */
export const defaultSlotIo: SlotIo = {
  isOwnerAlive(pid, startedAt) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
    }
    if (startedAt === null) return true;
    const now = defaultSlotIo.processStartTime(pid);
    // A different start time means the PID was reused by another process.
    return now === null || now === startedAt;
  },
  processStartTime(pid) {
    try {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out === '' ? null : out;
    } catch {
      return null;
    }
  },
  runningProjects() {
    const out = execFileSync(
      'docker',
      ['ps', '--format', '{{.Label "com.docker.compose.project"}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return new Set(out.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  },
  portInUse(port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (inUse: boolean): void => {
        socket.destroy();
        resolve(inUse);
      };
      socket.setTimeout(PORT_PROBE_MS, () => done(true));
      socket.once('connect', () => done(true));
      socket.once('error', (err: NodeJS.ErrnoException) => done(err.code !== 'ECONNREFUSED'));
    });
  },
  now: () => Date.now(),
};

/** Whether slot `slot`'s directory is held, stale, or absent (`null`). */
export function slotStatus(root: string, slot: number, io: SlotIo = defaultSlotIo): SlotStatus | null {
  let dirMtime: number;
  try {
    dirMtime = fs.statSync(slotDir(root, slot)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const record = readRecord(root, slot);
  if (record === null) {
    const ageMs = io.now() - dirMtime;
    return ageMs > RECORD_GRACE_MS
      ? { slot, record, state: 'stale', reason: 'no owner record, left by an acquirer that died', ageMs }
      : { slot, record, state: 'held', reason: 'being acquired', ageMs };
  }
  const ageMs = io.now() - Date.parse(record.acquiredAt);
  if (io.isOwnerAlive(record.ownerPid, record.ownerStartedAt)) {
    return { slot, record, state: 'held', reason: `owner pid ${record.ownerPid} runs`, ageMs };
  }
  let running: Set<string>;
  try {
    running = io.runningProjects();
  } catch (err) {
    return { slot, record, state: 'held', reason: `owner pid ${record.ownerPid} is gone, and docker does not answer, so its containers cannot be ruled out: ${(err as Error).message.split('\n')[0]}`, ageMs };
  }
  const live = record.projects.filter((p) => running.has(p));
  if (live.length > 0) {
    return { slot, record, state: 'held', reason: `owner pid ${record.ownerPid} is gone, compose project ${live.join(', ')} still runs`, ageMs };
  }
  return { slot, record, state: 'stale', reason: `owner pid ${record.ownerPid} is gone and no container of ${record.projects.join(', ')} runs`, ageMs };
}

/** Every slot directory under `root`, lowest slot first. */
export function listSlots(root: string, io: SlotIo = defaultSlotIo): SlotStatus[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const slots = names
    .map((n) => /^slot-(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  return slots.map((s) => slotStatus(root, s, io)).filter((s): s is SlotStatus => s !== null);
}

/** Moves slot `slot`'s directory away, then deletes it. */
function removeSlotDir(root: string, slot: number): void {
  const tomb = path.join(root, `.removed-slot-${slot}-${process.pid}-${Date.now()}`);
  try {
    fs.renameSync(slotDir(root, slot), tomb);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  fs.rmSync(tomb, { recursive: true, force: true });
}

/**
 * Removes slot `slot` when it is stale, and says whether it did. The check and
 * the removal run under one machine-wide lock (`<root>/.reclaim-lock`, taken by
 * `mkdir`): two acquirers that both saw the slot stale would otherwise race,
 * and the later one could delete the slot the earlier one had just taken. Under
 * the lock the later one sees the fresh slot as held. A lock left by a process
 * that died is removed, and the slot is looked at again on the next pass.
 */
export function reclaimIfStale(root: string, slot: number, io: SlotIo = defaultSlotIo): boolean {
  const lock = path.join(root, '.reclaim-lock');
  try {
    fs.mkdirSync(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let abandoned: boolean;
    try {
      abandoned = !io.isOwnerAlive(Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')), null);
    } catch {
      // No pid written yet: abandoned only when its taker died before writing one.
      try {
        abandoned = io.now() - fs.statSync(lock).mtimeMs > RECORD_GRACE_MS;
      } catch {
        abandoned = false;
      }
    }
    if (abandoned) fs.rmSync(lock, { recursive: true, force: true });
    return false;
  }
  try {
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    const status = slotStatus(root, slot, io);
    if (status === null || status.state !== 'stale') return false;
    removeSlotDir(root, slot);
    return true;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Removes every stale slot under `root` and returns their numbers. */
export function reclaimStaleSlots(root: string, io: SlotIo = defaultSlotIo): number[] {
  const out: number[] = [];
  for (const s of listSlots(root, io)) {
    if (s.state === 'stale' && reclaimIfStale(root, s.slot, io)) out.push(s.slot);
  }
  return out;
}

export interface AcquireOptions {
  root: string;
  /** Slots `0..max-1` are candidates. */
  max: number;
  /** The process whose life holds the slot. */
  ownerPid: number;
  kind?: StackKind;
  label?: string;
}

/** A slot whose number is free but whose ports something outside the slots holds. */
export interface BlockedSlot {
  slot: number;
  port: number;
}

export type TryAcquireResult =
  | { record: SlotRecord }
  | { record: null; holders: SlotStatus[]; blocked: BlockedSlot[] };

/**
 * One pass over slots `0..max-1`: takes the lowest free one, reclaiming a stale
 * one on the way. A slot whose number is free but one of whose ports (those a
 * stack of `kind` opens, `stackServices`) already accepts connections (a stack
 * started outside the slots, another app) is skipped and reported as blocked:
 * it is in use, whoever uses it.
 */
export async function tryAcquireSlot(opts: AcquireOptions, io: SlotIo = defaultSlotIo): Promise<TryAcquireResult> {
  fs.mkdirSync(opts.root, { recursive: true });
  const holders: SlotStatus[] = [];
  const blocked: BlockedSlot[] = [];
  for (let slot = 0; slot < opts.max; slot++) {
    if (!mkdirSlot(opts.root, slot)) {
      const status = slotStatus(opts.root, slot, io);
      if (status !== null && status.state === 'stale') reclaimIfStale(opts.root, slot, io);
      if (!mkdirSlot(opts.root, slot)) {
        const now = slotStatus(opts.root, slot, io);
        if (now !== null) holders.push(now);
        continue;
      }
    }
    const kind = opts.kind ?? 'regtest';
    const ports = slotPorts(slot);
    let busy: number | null = null;
    for (const service of stackServices(kind)) {
      const port = ports[service];
      if (await io.portInUse(port)) {
        busy = port;
        break;
      }
    }
    if (busy !== null) {
      removeSlotDir(opts.root, slot);
      blocked.push({ slot, port: busy });
      continue;
    }
    const prefix = slotPrefix(slot);
    const record: SlotRecord = {
      slot,
      ownerPid: opts.ownerPid,
      ownerStartedAt: io.processStartTime(opts.ownerPid),
      acquiredAt: new Date(io.now()).toISOString(),
      prefix,
      kind,
      projects: stackProjects(prefix),
      ports,
      label: opts.label ?? '',
    };
    const tmp = `${recordPath(opts.root, slot)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, recordPath(opts.root, slot));
    return { record };
  }
  return { record: null, holders, blocked };
}

function mkdirSlot(root: string, slot: number): boolean {
  try {
    fs.mkdirSync(slotDir(root, slot));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** One line per holder: slot, prefix, owner, age, why it is held. */
export function describeHolders(holders: readonly SlotStatus[], blocked: readonly BlockedSlot[] = []): string[] {
  const lines = holders.map((h) => {
    const who = h.record ? `${h.record.prefix} pid ${h.record.ownerPid}${h.record.label ? ` (${h.record.label})` : ''}` : '(no record yet)';
    return `  slot ${h.slot}: ${who}, ${formatAge(h.ageMs)} old, ${h.state}: ${h.reason}`;
  });
  for (const b of blocked) {
    lines.push(`  slot ${b.slot}: free, but port ${b.port} already accepts connections outside the slots (lsof -nP -iTCP:${b.port} -sTCP:LISTEN)`);
  }
  return lines;
}

/** `1h02m`, `3m05s`, `12s`. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export interface WaitOptions {
  /** Give up after this long (default {@link slotWaitMs}). */
  waitMs: number;
  /** Where the queue reports, one line at a time. */
  log: (line: string) => void;
  /** Resolves after `ms`; replaceable in a spec. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Takes a slot, waiting in line while all `max` are held. Prints who holds
 * each slot when the picture changes and again every minute, so a wait is
 * never silent, and gives up after `waitMs` with the holders and the command
 * that lists and reclaims slots. Ctrl-C ends the wait at once; nothing is held
 * until this resolves.
 */
export async function acquireSlot(opts: AcquireOptions, wait: WaitOptions, io: SlotIo = defaultSlotIo): Promise<SlotRecord> {
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = io.now();
  let lastPicture = '';
  let lastPrinted = 0;
  for (;;) {
    const res = await tryAcquireSlot(opts, io);
    if (res.record) return res.record;
    const lines = describeHolders(res.holders, res.blocked);
    const picture = lines.map((l) => l.replace(/, \S+ old,/, ',')).join('\n');
    const now = io.now();
    const waited = now - start;
    if (waited >= wait.waitMs) {
      throw new Error([
        `no regtest stack slot came free within ${formatAge(wait.waitMs)} (${MAX_STACKS_ENV}=${opts.max}). Held:`,
        ...lines,
        'A slot held longer than the longest lane runs is a stack nobody tore down.',
        `List them: node scripts/e2e-slots.mjs list (in the ordpool-sdk package). Tear down YOUR OWN: node scripts/e2e-slots.mjs down <slot>.`,
      ].join('\n'));
    }
    if (picture !== lastPicture || now - lastPrinted >= SLOT_HEARTBEAT_MS) {
      wait.log(`waiting for a regtest stack slot (${MAX_STACKS_ENV}=${opts.max}, waited ${formatAge(waited)} of ${formatAge(wait.waitMs)}, Ctrl-C to stop):`);
      for (const l of lines) wait.log(l);
      lastPicture = picture;
      lastPrinted = now;
    }
    await sleep(SLOT_POLL_MS);
  }
}

/**
 * Releases slot `slot`. With `ownerPid` it releases only a slot that process
 * holds, and throws otherwise, so a caller cannot drop another session's slot
 * by a wrong number.
 */
export function releaseSlot(root: string, slot: number, ownerPid?: number): void {
  const record = readRecord(root, slot);
  if (ownerPid !== undefined && record !== null && record.ownerPid !== ownerPid) {
    throw new Error(`slot ${slot} is held by pid ${record.ownerPid}, not ${ownerPid}; not released`);
  }
  removeSlotDir(root, slot);
}

/** `docker compose -p <project> down -v --remove-orphans` for each of the slot's projects. */
export function composeDown(record: SlotRecord): void {
  for (const project of record.projects) {
    execFileSync('docker', ['compose', '-p', project, 'down', '-v', '--remove-orphans'], { stdio: ['ignore', 'inherit', 'inherit'] });
  }
}

export interface RunInSlotOptions extends AcquireOptions {
  command: string;
  args: readonly string[];
  wait: WaitOptions;
  /** Tears the slot's stack down after the command; default {@link composeDown}. */
  teardown?: (record: SlotRecord) => void;
  /** The environment the command starts from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Called once the slot is held, before the command starts. */
  onAcquired?: (record: SlotRecord) => void;
}

/**
 * Acquires a slot, runs `command` with the slot's environment (`slotEnv`), then
 * tears the slot's stack down and releases it: on success, on failure, and on
 * SIGINT / SIGTERM / SIGHUP, which are passed to the command first. Resolves
 * to the command's exit code (128 + signal number when a signal ended it).
 *
 * When the teardown fails the slot is kept: its containers may still hold the
 * ports, and the slot frees itself once they are gone.
 */
export async function runInSlot(opts: RunInSlotOptions, io: SlotIo = defaultSlotIo): Promise<number> {
  const record = await acquireSlot(opts, opts.wait, io);
  opts.onAcquired?.(record);
  opts.wait.log(`slot ${record.slot}: ${record.prefix}, electrs :${record.ports.electrs}, bitcoind :${record.ports.bitcoindRpc}`);
  const teardown = opts.teardown ?? composeDown;
  const child = spawn(opts.command, [...opts.args], {
    stdio: 'inherit',
    env: { ...(opts.env ?? process.env), ...slotEnv(record.slot, record.kind) },
  });
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = (sig: NodeJS.Signals): void => {
    child.kill(sig);
  };
  for (const s of signals) process.on(s, forward);
  const code = await new Promise<number>((resolve) => {
    child.once('error', (err) => {
      opts.wait.log(`${opts.command}: ${err.message}`);
      resolve(127);
    });
    child.once('exit', (c, sig) => resolve(c ?? 128 + (sig ? os.constants.signals[sig] : 0)));
  });
  for (const s of signals) process.off(s, forward);
  try {
    teardown(record);
  } catch (err) {
    opts.wait.log(`slot ${record.slot}: teardown failed, slot kept until its containers are gone: ${(err as Error).message.split('\n')[0]}`);
    return code === 0 ? 1 : code;
  }
  releaseSlot(opts.root, record.slot, record.ownerPid);
  return code;
}
