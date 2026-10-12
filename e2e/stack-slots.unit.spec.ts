/**
 * @test-kind unit
 * Real:   tryAcquireSlot, acquireSlot, reclaimIfStale, reclaimStaleSlots, releaseSlot, runInSlot, slotStatus,
 *         maxStacks, slotWaitMs on a real slot directory (a fresh temp dir per case); defaultSlotIo's pid and
 *         port checks against real processes and sockets; the race cases run the compiled dist-e2e/stack-slots.js
 *         in separate node processes, the way two sessions meet
 * Faked:  SlotIo.runningProjects (the `docker ps` answer: a set of compose project names, the shape
 *         `docker ps --format '{{.Label "com.docker.compose.project"}}'` prints one per line), portInUse where a
 *         case decides which ports are taken, the clock and sleep of the waiting queue, and the teardown of runInSlot
 *         (a recorder instead of `docker compose down`)
 * Proves: concurrent acquirers never share a slot and never hold more than max between them, wherever the held
 *         slots sit, a stale slot is reclaimed exactly once, a slot whose owner is gone stays held while its
 *         containers run, a slot number whose ports are served outside the slots is passed over for the next one
 *         (max caps the count, not the numbers), the cap lock of a dead process is taken over, the queue says
 *         whether the cap or a port stops it, reports its holders and gives up at its bound, and runInSlot hands the slot's environment to
 *         the command, then tears down and releases on success and failure alike
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  acquireSlot,
  defaultSlotIo,
  maxStacks,
  reclaimIfStale,
  reclaimStaleSlots,
  releaseSlot,
  runInSlot,
  slotStatus,
  slotWaitMs,
  tryAcquireSlot,
  type SlotIo,
  type SlotRecord,
} from './stack-slots';

const PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-slots-'));
afterAll(() => fs.rmSync(PARENT, { recursive: true, force: true }));

function tempRoot(): string {
  return fs.mkdtempSync(path.join(PARENT, 'root-'));
}

/** A pid that ran and has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

/** Real pid checks, every port free, the given compose projects running, a clock the case moves. */
function fakeIo(over: Partial<SlotIo> & { running?: string[] } = {}): SlotIo & { clock: { t: number } } {
  const clock = { t: Date.parse('2026-10-12T12:00:00Z') };
  return {
    isOwnerAlive: defaultSlotIo.isOwnerAlive,
    processStartTime: defaultSlotIo.processStartTime,
    runningProjects: () => new Set(over.running ?? []),
    portInUse: async () => false,
    now: () => clock.t,
    ...over,
    clock,
  };
}

/** Writes a slot as another (gone) acquirer left it. */
function plantSlot(root: string, slot: number, ownerPid: number, prefix: string, acquiredAt = '2026-10-12T11:00:00.000Z'): void {
  fs.mkdirSync(path.join(root, `slot-${slot}`), { recursive: true });
  fs.writeFileSync(path.join(root, `slot-${slot}`, 'owner.json'), JSON.stringify({
    slot, ownerPid, ownerStartedAt: null, acquiredAt, prefix, kind: 'regtest',
    projects: [`${prefix}-regtest`, `${prefix}-consumer`], ports: {}, label: 'planted',
  }));
}

const me = process.pid;

describe('tryAcquireSlot', () => {
  it('takes the lowest free slot and records who holds it', async () => {
    const root = tempRoot();
    const io = fakeIo();
    const a = await tryAcquireSlot({ root, max: 2, ownerPid: me, label: 'case a' }, io);
    const b = await tryAcquireSlot({ root, max: 2, ownerPid: me }, io);
    expect(a.record?.slot).toBe(0);
    expect(b.record?.slot).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'slot-0', 'owner.json'), 'utf8')) as SlotRecord;
    expect(onDisk).toEqual({
      slot: 0,
      ownerPid: me,
      ownerStartedAt: defaultSlotIo.processStartTime(me),
      acquiredAt: '2026-10-12T12:00:00.000Z',
      prefix: 'ordpool-e2e',
      kind: 'regtest',
      projects: ['ordpool-e2e-regtest', 'ordpool-e2e-consumer'],
      ports: expect.objectContaining({ electrs: 3010, bitcoindRpc: 18443 }),
      label: 'case a',
    });
    expect(b.record?.prefix).toBe('ordpool-e2e-s1');
  });

  it('holds no more than max: the next acquirer gets nothing and learns who holds what', async () => {
    const root = tempRoot();
    const io = fakeIo();
    await tryAcquireSlot({ root, max: 2, ownerPid: me }, io);
    await tryAcquireSlot({ root, max: 2, ownerPid: me }, io);
    const third = await tryAcquireSlot({ root, max: 2, ownerPid: me }, io);
    expect(third.record).toBe(null);
    if (third.record !== null) throw new Error('unreachable');
    expect(third.reason).toBe('cap');
    expect(third.holders.map((h) => [h.slot, h.state, h.reason])).toEqual([
      [0, 'held', `owner pid ${me} runs`],
      [1, 'held', `owner pid ${me} runs`],
    ]);
  });

  it('reclaims a slot whose owner is gone and whose stack is down', async () => {
    const root = tempRoot();
    plantSlot(root, 0, deadPid(), 'ordpool-e2e');
    const got = await tryAcquireSlot({ root, max: 1, ownerPid: me }, fakeIo({ running: ['someone-else-regtest'] }));
    expect(got.record?.slot).toBe(0);
    expect(got.record?.ownerPid).toBe(me);
  });

  it('keeps a slot whose owner is gone while its compose project still runs', async () => {
    const root = tempRoot();
    const gone = deadPid();
    plantSlot(root, 0, gone, 'ordpool-e2e');
    const got = await tryAcquireSlot({ root, max: 2, ownerPid: me }, fakeIo({ running: ['ordpool-e2e-regtest'] }));
    expect(got.record?.slot).toBe(1);
    expect(slotStatus(root, 0, fakeIo({ running: ['ordpool-e2e-regtest'] }))?.reason)
      .toBe(`owner pid ${gone} is gone, compose project ordpool-e2e-regtest still runs`);
  });

  it('keeps a slot whose owner is gone when docker does not answer: its containers cannot be ruled out', async () => {
    const root = tempRoot();
    const gone = deadPid();
    plantSlot(root, 0, gone, 'ordpool-e2e');
    const io = fakeIo({ runningProjects: () => { throw new Error('Cannot connect to the Docker daemon'); } });
    const got = await tryAcquireSlot({ root, max: 1, ownerPid: me }, io);
    expect(got.record).toBe(null);
    expect(slotStatus(root, 0, io)?.reason).toBe(
      `owner pid ${gone} is gone, and docker does not answer, so its containers cannot be ruled out: Cannot connect to the Docker daemon`,
    );
  });

  it('with max 1, a port of slot 0 served outside the slots moves the stack to slot 1 instead of stopping it', async () => {
    const root = tempRoot();
    const io = fakeIo({ portInUse: async (port) => port === 8080 });
    const got = await tryAcquireSlot({ root, max: 1, ownerPid: me }, io);
    expect(got.record === null ? 'none' : [got.record.slot, got.record.prefix, got.record.ports.electrs, got.skipped])
      .toEqual([1, 'ordpool-e2e-s1', 3020, [{ slot: 0, port: 8080 }]]);
    expect(fs.readdirSync(root).filter((n) => n.startsWith('slot-'))).toEqual(['slot-1']);
    // The one stack the cap allows runs, so the next acquirer meets the cap, not the port.
    const next = await tryAcquireSlot({ root, max: 1, ownerPid: me }, io);
    expect(next.record === null ? [next.reason, next.holders.map((h) => h.slot), next.blocked] : 'acquired')
      .toEqual(['cap', [1], []]);
  });

  it('counts held slots wherever they sit: one held at slot 7 fills a cap of 1', async () => {
    const root = tempRoot();
    plantSlot(root, 7, me, 'ordpool-e2e-s7');
    const got = await tryAcquireSlot({ root, max: 1, ownerPid: me }, fakeIo());
    expect(got.record === null ? [got.reason, got.holders.map((h) => h.slot)] : 'acquired').toEqual(['cap', [7]]);
    expect((await tryAcquireSlot({ root, max: 2, ownerPid: me }, fakeIo())).record?.slot).toBe(0);
  });

  it('reports blocked, not cap, when below the cap every slot number has a port in use', async () => {
    const root = tempRoot();
    const got = await tryAcquireSlot({ root, max: 1, ownerPid: me }, fakeIo({ portInUse: async () => true }));
    expect(got.record === null ? [got.reason, got.holders, got.blocked.length, got.blocked[0]] : 'acquired')
      .toEqual(['blocked', [], 30, { slot: 0, port: 18443 }]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('probes only the ports its kind of stack opens', async () => {
    const root = tempRoot();
    // A MariaDB outside the slots on slot 0's 3306 does not stop a regtest stack there ...
    const mariadbTaken = fakeIo({ portInUse: async (port) => port === 3306 });
    expect((await tryAcquireSlot({ root, max: 1, ownerPid: me, kind: 'regtest' }, mariadbTaken)).record?.slot).toBe(0);
    // ... but moves a consumer stack, which publishes MariaDB, to slot 1 (MariaDB 3316).
    const other = tempRoot();
    const got = await tryAcquireSlot({ root: other, max: 1, ownerPid: me, kind: 'consumer' }, mariadbTaken);
    expect(got.record === null ? 'none' : [got.record.slot, got.record.ports.mariadb, got.skipped])
      .toEqual([1, 3316, [{ slot: 0, port: 3306 }]]);
  });

  it('takes the cap lock left by a process that died, and waits for one whose holder runs', async () => {
    const root = tempRoot();
    const lock = path.join(root, '.cap-lock');
    fs.writeFileSync(lock, String(deadPid()));
    expect((await tryAcquireSlot({ root, max: 1, ownerPid: me }, fakeIo())).record?.slot).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);

    const other = tempRoot();
    const held = path.join(other, '.cap-lock');
    fs.writeFileSync(held, String(me));
    let settled = false;
    const pending = tryAcquireSlot({ root: other, max: 1, ownerPid: me }, fakeIo()).then((r) => { settled = true; return r; });
    // One turn of the event loop runs every step that needs no timer: a pass that ignored the live lock
    // would have taken it over and created slot-0 by now.
    await new Promise((r) => setImmediate(r));
    expect([settled, fs.readFileSync(held, 'utf8'), fs.existsSync(path.join(other, 'slot-0'))]).toEqual([false, String(me), false]);
    fs.rmSync(held);
    expect((await pending).record?.slot).toBe(0);
  });

  it('treats a directory without a record as being acquired, and as abandoned after the grace minute', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'slot-0'));
    const io = fakeIo();
    io.clock.t = fs.statSync(path.join(root, 'slot-0')).mtimeMs + 30_000;
    expect(slotStatus(root, 0, io)?.state).toBe('held');
    expect((await tryAcquireSlot({ root, max: 1, ownerPid: me }, io)).record).toBe(null);
    io.clock.t += 31_000;
    expect(slotStatus(root, 0, io)?.state).toBe('stale');
    expect((await tryAcquireSlot({ root, max: 1, ownerPid: me }, io)).record?.slot).toBe(0);
  });
});

describe('defaultSlotIo', () => {
  it('tells a running owner from a gone one and from a reused pid', () => {
    expect(defaultSlotIo.isOwnerAlive(me, null)).toBe(true);
    expect(defaultSlotIo.isOwnerAlive(me, defaultSlotIo.processStartTime(me))).toBe(true);
    expect(defaultSlotIo.isOwnerAlive(me, 'Thu Jan  1 00:00:00 1970')).toBe(false);
    expect(defaultSlotIo.isOwnerAlive(deadPid(), null)).toBe(false);
  });

  it('sees a listening port as in use and a closed one as free', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await defaultSlotIo.portInUse(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await defaultSlotIo.portInUse(port)).toBe(false);
  });
});

describe('reclaimIfStale', () => {
  it('a reclaim that comes after another acquirer took the slot leaves the new holder alone', async () => {
    const root = tempRoot();
    plantSlot(root, 0, deadPid(), 'ordpool-e2e');
    const io = fakeIo();
    // Acquirer A has looked and seen the slot stale ...
    expect(slotStatus(root, 0, io)?.state).toBe('stale');
    // ... acquirer B reclaims it and takes it first ...
    expect((await tryAcquireSlot({ root, max: 1, ownerPid: me, label: 'B' }, io)).record?.label).toBe('B');
    // ... and A's reclaim, decided on what it saw, finds the slot held and keeps it.
    expect(reclaimIfStale(root, 0, io)).toBe(false);
    expect((JSON.parse(fs.readFileSync(path.join(root, 'slot-0', 'owner.json'), 'utf8')) as SlotRecord).label).toBe('B');
  });

  it('waits for a reclaim lock whose taker runs, and clears one whose taker is gone', () => {
    const root = tempRoot();
    plantSlot(root, 0, deadPid(), 'ordpool-e2e');
    const lock = path.join(root, '.reclaim-lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), String(me));
    expect(reclaimIfStale(root, 0, fakeIo())).toBe(false);
    expect(fs.existsSync(path.join(root, 'slot-0'))).toBe(true);
    fs.writeFileSync(path.join(lock, 'pid'), String(deadPid()));
    expect(reclaimIfStale(root, 0, fakeIo())).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    expect(reclaimIfStale(root, 0, fakeIo())).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('reclaimStaleSlots and releaseSlot', () => {
  it('reclaims only the stale slots', () => {
    const root = tempRoot();
    plantSlot(root, 0, deadPid(), 'ordpool-e2e');
    plantSlot(root, 1, me, 'ordpool-e2e-s1');
    plantSlot(root, 2, deadPid(), 'ordpool-e2e-s2');
    expect(reclaimStaleSlots(root, fakeIo({ running: ['ordpool-e2e-s2-consumer'] }))).toEqual([0]);
    expect(fs.readdirSync(root).sort()).toEqual(['slot-1', 'slot-2']);
  });

  it('releases a slot only for its owner when an owner is named', () => {
    const root = tempRoot();
    plantSlot(root, 0, me, 'ordpool-e2e');
    expect(() => releaseSlot(root, 0, me + 1)).toThrow(`slot 0 is held by pid ${me}, not ${me + 1}; not released`);
    releaseSlot(root, 0, me);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('acquireSlot (the queue)', () => {
  it('waits while all slots are held, names the holders, and takes the slot that frees', async () => {
    const root = tempRoot();
    plantSlot(root, 0, me, 'ordpool-e2e');
    const io = fakeIo();
    const lines: string[] = [];
    let polls = 0;
    const record = await acquireSlot({ root, max: 1, ownerPid: me }, {
      waitMs: 600_000,
      log: (l) => lines.push(l),
      sleep: async (ms) => {
        io.clock.t += ms;
        polls += 1;
        if (polls === 3) fs.rmSync(path.join(root, 'slot-0'), { recursive: true });
      },
    }, io);
    expect(record.slot).toBe(0);
    expect(polls).toBe(3);
    expect(lines[0]).toBe('waiting for a regtest stack slot, cap reached: 1 of ORDPOOL_E2E_MAX_STACKS=1 slots held (waited 0s of 10m00s, Ctrl-C to stop):');
    expect(lines[1]).toBe(`  slot 0: ordpool-e2e pid ${me} (planted), 1h00m old, held: owner pid ${me} runs`);
    // The picture did not change and no minute passed: one report, not one per poll.
    expect(lines.length).toBe(2);
  });

  it('says which slot number it passed over and why, once it holds a slot', async () => {
    const root = tempRoot();
    const lines: string[] = [];
    // waitMs 0: the first pass must take slot 1; a pass that waits instead throws.
    const record = await acquireSlot({ root, max: 1, ownerPid: me, kind: 'consumer' }, {
      waitMs: 0,
      log: (l) => lines.push(l),
    }, fakeIo({ portInUse: async (port) => port === 3306 }));
    expect(record.slot).toBe(1);
    expect(lines).toEqual(['skipped slot 0: port 3306 in use by a non-slot process (lsof -nP -iTCP:3306 -sTCP:LISTEN)']);
  });

  it('names the ports in use, not the cap, when below the cap no slot number is clear', async () => {
    const root = tempRoot();
    const io = fakeIo({ portInUse: async (port) => port % 10 === 6 && port >= 3306 && port <= 3306 + 290 });
    const lines: string[] = [];
    await expect(acquireSlot({ root, max: 1, ownerPid: me, kind: 'consumer' }, {
      waitMs: 0,
      log: (l) => lines.push(l),
    }, io)).rejects.toThrow([
      'no regtest stack slot came free within 0s, 0 of ORDPOOL_E2E_MAX_STACKS=1 slots held, but every free slot number has a port in use by a non-slot process:',
      '  slot 0: port 3306 in use by a non-slot process (lsof -nP -iTCP:3306 -sTCP:LISTEN)',
      '  slot 1: port 3316 in use by a non-slot process (lsof -nP -iTCP:3316 -sTCP:LISTEN)',
    ].join('\n'));
  });

  it('repeats the holders every minute while nothing changes', async () => {
    const root = tempRoot();
    plantSlot(root, 0, me, 'ordpool-e2e');
    const io = fakeIo();
    const lines: string[] = [];
    let polls = 0;
    await acquireSlot({ root, max: 1, ownerPid: me }, {
      waitMs: 600_000,
      log: (l) => lines.push(l),
      sleep: async (ms) => {
        io.clock.t += ms;
        polls += 1;
        if (polls === 13) fs.rmSync(path.join(root, 'slot-0'), { recursive: true });
      },
    }, io);
    expect(lines.filter((l) => l.startsWith('waiting for')).length).toBe(2);
    expect(lines[2]).toBe('waiting for a regtest stack slot, cap reached: 1 of ORDPOOL_E2E_MAX_STACKS=1 slots held (waited 1m00s of 10m00s, Ctrl-C to stop):');
  });

  it('gives up at its bound with the holders and how to list and tear down', async () => {
    const root = tempRoot();
    plantSlot(root, 0, me, 'ordpool-e2e');
    const io = fakeIo();
    let polls = 0;
    await expect(acquireSlot({ root, max: 1, ownerPid: me }, {
      waitMs: 20_000,
      log: () => undefined,
      sleep: async (ms) => { io.clock.t += ms; polls += 1; },
    }, io)).rejects.toThrow([
      'no regtest stack slot came free within 20s, cap reached: 1 of ORDPOOL_E2E_MAX_STACKS=1 slots held:',
      `  slot 0: ordpool-e2e pid ${me} (planted), 1h00m old, held: owner pid ${me} runs`,
      'A slot held longer than the longest lane runs is a stack nobody tore down.',
    ].join('\n'));
    expect(polls).toBe(4);
  });
});

describe('runInSlot', () => {
  const quietWait = { waitMs: 0, log: () => undefined };

  it('runs the command in the slot environment, then tears down and releases', async () => {
    const root = tempRoot();
    const torn: number[] = [];
    const code = await runInSlot({
      root, max: 3, ownerPid: me, wait: quietWait,
      command: process.execPath,
      args: ['-e', "process.exit(process.env.E2E_SLOT === '0' && process.env.E2E_ELECTRS_HOST_PORT === '3010' && process.env.E2E_PREFIX === 'ordpool-e2e' && process.env.REGTEST_BITCOIND_CONTAINER === 'ordpool-e2e-bitcoind' ? 0 : 9)"],
      teardown: (r) => torn.push(r.slot),
    }, fakeIo());
    expect(code).toBe(0);
    expect(torn).toEqual([0]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('tears down and releases after a failing command too, and passes its exit code on', async () => {
    const root = tempRoot();
    plantSlot(root, 0, me, 'ordpool-e2e');
    const torn: SlotRecord[] = [];
    const code = await runInSlot({
      root, max: 3, ownerPid: me, kind: 'consumer', wait: quietWait,
      command: process.execPath,
      args: ['-e', "process.exit(process.env.REGTEST_BITCOIND_CONTAINER === 'ordpool-e2e-s1-consumer-bitcoind' ? 3 : 9)"],
      teardown: (r) => torn.push(r),
    }, fakeIo());
    expect(code).toBe(3);
    expect(torn.map((r) => [r.slot, r.projects])).toEqual([[1, ['ordpool-e2e-s1-regtest', 'ordpool-e2e-s1-consumer']]]);
    expect(fs.readdirSync(root)).toEqual(['slot-0']);
  });

  it('keeps the slot when the teardown fails, and fails', async () => {
    const root = tempRoot();
    const code = await runInSlot({
      root, max: 1, ownerPid: me, wait: quietWait,
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      teardown: () => { throw new Error('docker compose down: exit 1'); },
    }, fakeIo());
    expect(code).toBe(1);
    expect(fs.readdirSync(root)).toEqual(['slot-0']);
  });
});

describe('maxStacks and slotWaitMs', () => {
  it('default to one stack and the 40 minute cap of the longest lane', () => {
    expect(maxStacks({})).toBe(1);
    expect(slotWaitMs({})).toBe(2_400_000);
  });

  it('read their variables and refuse what the layout cannot serve', () => {
    expect(maxStacks({ ORDPOOL_E2E_MAX_STACKS: '3' })).toBe(3);
    expect(() => maxStacks({ ORDPOOL_E2E_MAX_STACKS: '0' })).toThrow('ORDPOOL_E2E_MAX_STACKS=0 must be an integer from 1 to 30');
    expect(() => maxStacks({ ORDPOOL_E2E_MAX_STACKS: '31' })).toThrow('ORDPOOL_E2E_MAX_STACKS=31 must be an integer from 1 to 30');
    expect(slotWaitMs({ ORDPOOL_E2E_SLOT_WAIT_MS: '5000' })).toBe(5000);
  });
});

/**
 * Racers: separate node processes, each loading the COMPILED allocator (what the
 * CLI runs) and calling tryAcquireSlot once, all released at the same instant.
 * Every slot is owned by this test process, which outlives them all, so a held
 * slot stays held; ports are free and docker reports nothing running.
 */
const COMPILED = path.resolve(__dirname, '../dist-e2e/stack-slots.js');
const RACER = `
  const fs = require('node:fs');
  const slots = require(${JSON.stringify(COMPILED)});
  const [root, max, owner, go, busyPort, kind] = process.argv.slice(1);
  const io = { ...slots.defaultSlotIo, runningProjects: () => new Set(), portInUse: async (p) => p === Number(busyPort) };
  process.stderr.write('ready\\n');
  const tick = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(go)) Atomics.wait(tick, 0, 0, 1);
  slots.tryAcquireSlot({ root, max: Number(max), ownerPid: Number(owner), kind }, io)
    .then((r) => process.stdout.write(JSON.stringify(r.record ? r.record.slot : null)));
`;

/**
 * Starts `racers` processes, releases them together once all are loaded, returns the slot each got.
 * Every racer sees `busyPort` as served outside the slots (0: no port).
 */
async function race(root: string, max: number, racers: number, busyPort = 0, kind: 'regtest' | 'consumer' = 'regtest'): Promise<(number | null)[]> {
  const go = path.join(root, '..', `${path.basename(root)}.go`);
  const children = Array.from({ length: racers }, () => spawn(process.execPath, ['-e', RACER, root, String(max), String(me), go, String(busyPort), kind]));
  const ready = children.map((c) => new Promise<void>((resolve) => {
    c.stderr.once('data', () => resolve());
  }));
  const outputs = children.map((c) => new Promise<number | null>((resolve, reject) => {
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out) as number | null) : reject(new Error(`racer exited ${code}: ${err}`))));
  }));
  await Promise.all(ready);
  fs.writeFileSync(go, '');
  return Promise.all(outputs);
}

/** The slot directories under `root`. */
function slotDirs(root: string): string[] {
  return fs.readdirSync(root).filter((n) => n.startsWith('slot-')).sort();
}

describe('racing processes', () => {
  it.each([1, 2, 3, 4, 5])('round %i: 12 processes, max 3, never share a slot and never exceed the cap', async () => {
    const root = tempRoot();
    const got = await race(root, 3, 12);
    const slots = got.filter((s): s is number => s !== null).sort();
    expect(slots).toEqual([0, 1, 2]);
    expect(got.filter((s) => s === null).length).toBe(9);
    expect(slotDirs(root)).toEqual(['slot-0', 'slot-1', 'slot-2']);
  });

  it.each([1, 2, 3, 4, 5])('round %i: 10 processes, max 2, one slot already held at 7: exactly one more is taken', async () => {
    const root = tempRoot();
    plantSlot(root, 7, me, 'ordpool-e2e-s7');
    const got = await race(root, 2, 10);
    expect(got.filter((s) => s !== null)).toEqual([0]);
    expect(slotDirs(root)).toEqual(['slot-0', 'slot-7']);
  });

  it.each([1, 2, 3, 4, 5])('round %i: 10 consumer processes, max 1, slot 0 MariaDB port served outside: exactly one gets slot 1', async () => {
    const root = tempRoot();
    const got = await race(root, 1, 10, 3306, 'consumer');
    expect(got.filter((s) => s !== null)).toEqual([1]);
    expect(slotDirs(root)).toEqual(['slot-1']);
  });

  it.each([1, 2, 3])('round %i: 8 processes reclaiming one stale slot, exactly one gets it', async () => {
    const root = tempRoot();
    plantSlot(root, 0, deadPid(), 'ordpool-e2e');
    const got = await race(root, 1, 8);
    expect(got.filter((s) => s === 0).length).toBe(1);
    expect(got.filter((s) => s === null).length).toBe(7);
    expect((JSON.parse(fs.readFileSync(path.join(root, 'slot-0', 'owner.json'), 'utf8')) as SlotRecord).ownerPid).toBe(me);
  });
});
