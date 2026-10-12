import { type StackKind, type StackService } from './stack-ports';
/** Sets how many stacks may run on this machine at once. */
export declare const MAX_STACKS_ENV = "ORDPOOL_E2E_MAX_STACKS";
/** Overrides the slot directory. */
export declare const SLOT_DIR_ENV = "ORDPOOL_E2E_SLOT_DIR";
/** Overrides how long `acquireSlot` waits for a free slot, in milliseconds. */
export declare const SLOT_WAIT_ENV = "ORDPOOL_E2E_SLOT_WAIT_MS";
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
export declare const DEFAULT_MAX_STACKS = 1;
/**
 * The default bound of the wait for a slot: 40 minutes, the job cap of the
 * longest lane that holds a stack (`timeout-minutes: 40` of the wallet matrix
 * in `.github/workflows/e2e-playwright.yml`, which covers a cold xverse shard).
 * A slot that stays held longer than the longest lane may run is not a queue
 * any more; it is a stack nobody tore down, and waiting longer cannot help.
 */
export declare const DEFAULT_SLOT_WAIT_MS: number;
/** How often a waiting acquirer looks again. */
export declare const SLOT_POLL_MS = 5000;
/** How often a waiting acquirer repeats who holds the slots when nothing changed. */
export declare const SLOT_HEARTBEAT_MS = 60000;
/**
 * How long a slot directory may exist without `owner.json` before it counts as
 * abandoned. An acquirer writes the record right after one port probe of its
 * slot (every probe a loopback connect, answered at once); a directory still
 * without a record after a minute was left by an acquirer that died between
 * the two steps.
 */
export declare const RECORD_GRACE_MS = 60000;
/**
 * Bound of one port probe. A loopback connect is refused or accepted at once;
 * a probe that hangs counts as a port in use.
 */
export declare const PORT_PROBE_MS = 1000;
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
export declare function slotRoot(env?: NodeJS.ProcessEnv): string;
/** `ORDPOOL_E2E_MAX_STACKS`, else {@link DEFAULT_MAX_STACKS}. Throws on a value the port layout cannot serve. */
export declare function maxStacks(env?: NodeJS.ProcessEnv): number;
/** `ORDPOOL_E2E_SLOT_WAIT_MS`, else {@link DEFAULT_SLOT_WAIT_MS}. */
export declare function slotWaitMs(env?: NodeJS.ProcessEnv): number;
/** The real side effects: `kill -0`, `ps`, `docker ps`, a loopback connect. */
export declare const defaultSlotIo: SlotIo;
/** Whether slot `slot`'s directory is held, stale, or absent (`null`). */
export declare function slotStatus(root: string, slot: number, io?: SlotIo): SlotStatus | null;
/** Every slot directory under `root`, lowest slot first. */
export declare function listSlots(root: string, io?: SlotIo): SlotStatus[];
/**
 * Removes slot `slot` when it is stale, and says whether it did. The check and
 * the removal run under one machine-wide lock (`<root>/.reclaim-lock`, taken by
 * `mkdir`): two acquirers that both saw the slot stale would otherwise race,
 * and the later one could delete the slot the earlier one had just taken. Under
 * the lock the later one sees the fresh slot as held. A lock left by a process
 * that died is removed, and the slot is looked at again on the next pass.
 */
export declare function reclaimIfStale(root: string, slot: number, io?: SlotIo): boolean;
/** Removes every stale slot under `root` and returns their numbers. */
export declare function reclaimStaleSlots(root: string, io?: SlotIo): number[];
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
export type TryAcquireResult = {
    record: SlotRecord;
} | {
    record: null;
    holders: SlotStatus[];
    blocked: BlockedSlot[];
};
/**
 * One pass over slots `0..max-1`: takes the lowest free one, reclaiming a stale
 * one on the way. A slot whose number is free but one of whose ports (those a
 * stack of `kind` opens, `stackServices`) already accepts connections (a stack
 * started outside the slots, another app) is skipped and reported as blocked:
 * it is in use, whoever uses it.
 */
export declare function tryAcquireSlot(opts: AcquireOptions, io?: SlotIo): Promise<TryAcquireResult>;
/** One line per holder: slot, prefix, owner, age, why it is held. */
export declare function describeHolders(holders: readonly SlotStatus[], blocked?: readonly BlockedSlot[]): string[];
/** `1h02m`, `3m05s`, `12s`. */
export declare function formatAge(ms: number): string;
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
export declare function acquireSlot(opts: AcquireOptions, wait: WaitOptions, io?: SlotIo): Promise<SlotRecord>;
/**
 * Releases slot `slot`. With `ownerPid` it releases only a slot that process
 * holds, and throws otherwise, so a caller cannot drop another session's slot
 * by a wrong number.
 */
export declare function releaseSlot(root: string, slot: number, ownerPid?: number): void;
/** `docker compose -p <project> down -v --remove-orphans` for each of the slot's projects. */
export declare function composeDown(record: SlotRecord): void;
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
export declare function runInSlot(opts: RunInSlotOptions, io?: SlotIo): Promise<number>;
//# sourceMappingURL=stack-slots.d.ts.map