"use strict";
/**
 * The host ports and names of one regtest stack, derived from its slot.
 *
 * A machine runs at most `ORDPOOL_E2E_MAX_STACKS` stacks at once (see
 * `stack-slots.ts`). Each holds one slot `N`, and everything the stack
 * publishes on the host comes from `N`:
 *
 *     host port = SLOT_PORT_BASES[service] + N * SLOT_PORT_STRIDE
 *     E2E_PREFIX = N === 0 ? 'ordpool-e2e' : `ordpool-e2e-s${N}`
 *
 * Slot 0 publishes the ports and names a single CI runner uses (electrs 3010,
 * cat21-ord 8080, `ordpool-e2e-bitcoind`, ...), so a runner, which only ever
 * holds slot 0, keeps them.
 *
 * Container-internal ports stay fixed (bitcoind 18443, electrs 3000, ord 8080
 * inside its container): only the host side of a `ports:` mapping moves, and
 * nothing outside the stack ever reaches a container port directly.
 *
 * Pure: no IO, so a spec, a config file, a `.mjs` script and the allocator
 * all read the same answer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SLOTS_SUPPORTED = exports.PREFIX_ENV = exports.SLOT_ENV = exports.SLOT_PORT_ENV = exports.SLOT_PORT_STRIDE = exports.SLOT_PORT_BASES = void 0;
exports.assertSlotNumber = assertSlotNumber;
exports.slotPorts = slotPorts;
exports.slotPrefix = slotPrefix;
exports.stackServices = stackServices;
exports.stackContainers = stackContainers;
exports.stackProjects = stackProjects;
exports.slotEnv = slotEnv;
exports.stackPort = stackPort;
exports.stackUrl = stackUrl;
/**
 * Slot 0's host port per service: the ports a single CI runner publishes.
 *
 * - `ordpoolBackend` and `feesStub` are different services that both answered
 *   on 8999 by default. Consumer lanes run the fees stub there, so the stub
 *   keeps 8999 and the real ordpool backend (compose profile `ordpool-backend`)
 *   takes 8998: both can then run in one stack.
 * - `app` is a consumer's static app server, `appBackend` its own backend
 *   process (cat21-indexer's NestJS). One value for every consumer, so two
 *   consumers' lanes in two slots never meet.
 */
exports.SLOT_PORT_BASES = {
    bitcoindRpc: 18443,
    bitcoindP2p: 18444,
    zmqRawBlock: 28332,
    zmqRawTx: 28333,
    electrs: 3010,
    electrum: 50001,
    ord: 8080,
    ordStock: 8081,
    ordpoolBackend: 8998,
    feesStub: 8999,
    mariadb: 3306,
    redis: 6379,
    harness: 4500,
    app: 4200,
    appBackend: 9998,
};
/** How far one slot's ports sit from the previous slot's. */
exports.SLOT_PORT_STRIDE = 10;
/**
 * The environment variable that carries each service's host port. The compose
 * files, the bootstrap scripts, `regtestServiceUrls` and the fixtures server
 * read these names.
 */
exports.SLOT_PORT_ENV = {
    bitcoindRpc: 'E2E_BITCOIND_RPC_HOST_PORT',
    bitcoindP2p: 'E2E_BITCOIND_P2P_HOST_PORT',
    zmqRawBlock: 'E2E_ZMQ_RAWBLOCK_HOST_PORT',
    zmqRawTx: 'E2E_ZMQ_RAWTX_HOST_PORT',
    electrs: 'E2E_ELECTRS_HOST_PORT',
    electrum: 'E2E_ELECTRUM_HOST_PORT',
    ord: 'E2E_ORD_HOST_PORT',
    ordStock: 'E2E_ORD_STOCK_HOST_PORT',
    ordpoolBackend: 'E2E_ORDPOOL_BACKEND_HOST_PORT',
    feesStub: 'E2E_FEES_STUB_PORT',
    mariadb: 'E2E_MARIADB_HOST_PORT',
    redis: 'E2E_REDIS_HOST_PORT',
    harness: 'E2E_HARNESS_PORT',
    app: 'E2E_APP_PORT',
    appBackend: 'E2E_APP_BACKEND_PORT',
};
/** The slot number of the stack, as the allocator exports it. */
exports.SLOT_ENV = 'E2E_SLOT';
/** The compose project / container name prefix of the stack. */
exports.PREFIX_ENV = 'E2E_PREFIX';
/**
 * The highest slot count the port layout supports: the largest `n` for which
 * slots `0..n-1` never give two services the same port. Two bases collide only
 * when they are congruent modulo the stride, at `|a - b| / stride` slots apart;
 * 4200 (app) and 4500 (harness) are the closest such pair, so 30.
 */
exports.MAX_SLOTS_SUPPORTED = (() => {
    const bases = Object.values(exports.SLOT_PORT_BASES);
    let limit = Math.floor((65_535 - Math.max(...bases)) / exports.SLOT_PORT_STRIDE) + 1;
    for (let i = 0; i < bases.length; i++) {
        for (let j = i + 1; j < bases.length; j++) {
            const d = Math.abs(bases[i] - bases[j]);
            if (d % exports.SLOT_PORT_STRIDE === 0)
                limit = Math.min(limit, d / exports.SLOT_PORT_STRIDE);
        }
    }
    return limit;
})();
/** Throws unless `slot` is a slot number the layout supports. */
function assertSlotNumber(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= exports.MAX_SLOTS_SUPPORTED) {
        throw new Error(`slot ${slot} is outside 0..${exports.MAX_SLOTS_SUPPORTED - 1}, the slots the port layout supports`);
    }
}
/** Every host port of slot `slot`. */
function slotPorts(slot) {
    assertSlotNumber(slot);
    const out = {};
    for (const [service, base] of Object.entries(exports.SLOT_PORT_BASES)) {
        out[service] = base + slot * exports.SLOT_PORT_STRIDE;
    }
    return out;
}
/**
 * The compose project / container prefix of slot `slot`: `ordpool-e2e` for
 * slot 0, the compose files' default, so a runner (always slot 0) keeps the
 * container names its workflow already reads (`ordpool-e2e-bitcoind`,
 * `ordpool-e2e-consumer-bitcoind`); `ordpool-e2e-s<N>` for every other slot.
 */
function slotPrefix(slot) {
    assertSlotNumber(slot);
    return slot === 0 ? 'ordpool-e2e' : `ordpool-e2e-s${slot}`;
}
/**
 * The services a stack of `kind` publishes on the host, its compose services
 * plus what runs beside it (fees stub, harness, a consumer's app and backend).
 * The allocator probes these ports before it hands out a slot: a port the
 * stack never opens does not make the slot unusable.
 */
function stackServices(kind) {
    const all = Object.keys(exports.SLOT_PORT_BASES);
    const notPublished = kind === 'regtest'
        ? ['zmqRawBlock', 'zmqRawTx', 'mariadb', 'redis']
        : ['ordpoolBackend'];
    return all.filter((s) => !notPublished.includes(s));
}
/**
 * The container names of a stack: `docker-compose.regtest.yml` names them
 * `<prefix>-<service>`, `docker-compose.consumer-environment.yml`
 * `<prefix>-consumer-<service>`.
 */
function stackContainers(prefix, kind) {
    const p = kind === 'consumer' ? `${prefix}-consumer` : prefix;
    return {
        bitcoind: `${p}-bitcoind`,
        electrs: `${p}-electrs`,
        ord: `${p}-cat21-ord`,
        ordStock: `${p}-ord-stock`,
        mariadb: `${p}-mariadb`,
        redis: `${p}-redis`,
    };
}
/** The compose projects a stack under `prefix` can create, one per compose file. */
function stackProjects(prefix) {
    return [`${prefix}-regtest`, `${prefix}-consumer`];
}
/**
 * The environment of a stack in slot `slot`: `E2E_SLOT`, `E2E_PREFIX`, one
 * variable per host port, and the container names the regtest helpers
 * `docker exec` into (`REGTEST_BITCOIND_CONTAINER` and its siblings).
 */
function slotEnv(slot, kind = 'regtest') {
    const ports = slotPorts(slot);
    const prefix = slotPrefix(slot);
    const containers = stackContainers(prefix, kind);
    const env = {
        [exports.SLOT_ENV]: String(slot),
        [exports.PREFIX_ENV]: prefix,
        REGTEST_BITCOIND_CONTAINER: containers.bitcoind,
        REGTEST_ORD_CONTAINER: containers.ord,
        REGTEST_ORD_STOCK_CONTAINER: containers.ordStock,
    };
    for (const service of Object.keys(ports)) {
        env[exports.SLOT_PORT_ENV[service]] = String(ports[service]);
    }
    return env;
}
/**
 * The host port of `service` as `env` sets it, else slot 0's. A set value must
 * be a TCP port; anything else throws, because a typo would otherwise send a
 * lane to slot 0's stack, which may be another session's.
 */
function stackPort(service, env = process.env) {
    const name = exports.SLOT_PORT_ENV[service];
    const raw = env[name];
    if (raw === undefined || raw === '')
        return exports.SLOT_PORT_BASES[service];
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`${name}=${raw} is not a TCP port`);
    }
    return port;
}
/** `http://localhost:<port>` of `service`, from `env`. */
function stackUrl(service, env = process.env) {
    return `http://localhost:${stackPort(service, env)}`;
}
//# sourceMappingURL=stack-ports.js.map