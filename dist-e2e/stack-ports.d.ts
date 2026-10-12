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
/** Every host port a stack, its harness or its consumer app publishes. */
export type StackService = 'bitcoindRpc' | 'bitcoindP2p' | 'zmqRawBlock' | 'zmqRawTx' | 'electrs' | 'electrum' | 'ord' | 'ordStock' | 'ordpoolBackend' | 'feesStub' | 'mariadb' | 'redis' | 'harness' | 'app' | 'appBackend';
/**
 * Slot 0's host port per service: the ports a single CI runner publishes.
 *
 * - `ordpoolBackend` and `feesStub` are different services that both answered
 *   on 8999 by default. The real ordpool backend (compose profile
 *   `ordpool-backend`) keeps 8999, the port cubes' regtest build compiles in;
 *   the fees stub, which every consumer lane starts with an explicit `PORT`,
 *   takes 8998. Both can then run in one stack.
 * - `app` is a consumer's static app server, `appBackend` its own backend
 *   process (cat21-indexer's NestJS). One value for every consumer, so two
 *   consumers' lanes in two slots never meet.
 */
export declare const SLOT_PORT_BASES: Readonly<Record<StackService, number>>;
/** How far one slot's ports sit from the previous slot's. */
export declare const SLOT_PORT_STRIDE = 10;
/**
 * The environment variable that carries each service's host port. The compose
 * files, the bootstrap scripts, `regtestServiceUrls` and the fixtures server
 * read these names.
 */
export declare const SLOT_PORT_ENV: Readonly<Record<StackService, string>>;
/** The slot number of the stack, as the allocator exports it. */
export declare const SLOT_ENV = "E2E_SLOT";
/** The compose project / container name prefix of the stack. */
export declare const PREFIX_ENV = "E2E_PREFIX";
/**
 * The highest slot count the port layout supports: the largest `n` for which
 * slots `0..n-1` never give two services the same port. Two bases collide only
 * when they are congruent modulo the stride, at `|a - b| / stride` slots apart;
 * 4200 (app) and 4500 (harness) are the closest such pair, so 30.
 */
export declare const MAX_SLOTS_SUPPORTED: number;
/** Throws unless `slot` is a slot number the layout supports. */
export declare function assertSlotNumber(slot: number): void;
/** Every host port of slot `slot`. */
export declare function slotPorts(slot: number): Record<StackService, number>;
/**
 * The compose project / container prefix of slot `slot`: `ordpool-e2e` for
 * slot 0, the compose files' default, so a runner (always slot 0) keeps the
 * container names its workflow already reads (`ordpool-e2e-bitcoind`,
 * `ordpool-e2e-consumer-bitcoind`); `ordpool-e2e-s<N>` for every other slot.
 */
export declare function slotPrefix(slot: number): string;
/** Which compose file the stack comes from: it decides the container names. */
export type StackKind = 'regtest' | 'consumer';
/**
 * The services a stack of `kind` publishes on the host, its compose services
 * plus what runs beside it (fees stub, harness, a consumer's app and backend).
 * The allocator probes these ports before it hands out a slot: a port the
 * stack never opens does not make the slot unusable.
 */
export declare function stackServices(kind: StackKind): StackService[];
/**
 * The container names of a stack: `docker-compose.regtest.yml` names them
 * `<prefix>-<service>`, `docker-compose.consumer-environment.yml`
 * `<prefix>-consumer-<service>`.
 */
export declare function stackContainers(prefix: string, kind: StackKind): {
    bitcoind: string;
    electrs: string;
    ord: string;
    ordStock: string;
    mariadb: string;
    redis: string;
};
/** The compose projects a stack under `prefix` can create, one per compose file. */
export declare function stackProjects(prefix: string): string[];
/**
 * The environment of a stack in slot `slot`: `E2E_SLOT`, `E2E_PREFIX`, one
 * variable per host port, and the container names the regtest helpers
 * `docker exec` into (`REGTEST_BITCOIND_CONTAINER` and its siblings).
 */
export declare function slotEnv(slot: number, kind?: StackKind): Record<string, string>;
/**
 * The host port of `service` as `env` sets it, else slot 0's. A set value must
 * be a TCP port; anything else throws, because a typo would otherwise send a
 * lane to slot 0's stack, which may be another session's.
 */
export declare function stackPort(service: StackService, env?: NodeJS.ProcessEnv): number;
/** `http://localhost:<port>` of `service`, from `env`. */
export declare function stackUrl(service: StackService, env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=stack-ports.d.ts.map