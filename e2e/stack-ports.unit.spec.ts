/**
 * @test-kind unit
 * Real:   slotPorts, slotPrefix, slotEnv, stackPort, stackContainers, MAX_SLOTS_SUPPORTED, regtestServiceUrls,
 *         reachableHosts, the compose files and bootstrap scripts as they are on disk
 * Faked:  nothing; every environment is a plain object passed in
 * Proves: slot 0 publishes the ports a CI runner uses, slot N moves every host port by 10 N, no two services of
 *         any supported slots share a port, the compose files and scripts publish only env-driven host ports
 *         whose defaults are slot 0's, and the service URLs the helpers and the browser launch read follow the slot
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { regtestServiceUrls } from './regtest/regtest-helpers';
import {
  MAX_SLOTS_SUPPORTED,
  SLOT_PORT_ENV,
  slotEnv,
  slotPorts,
  slotPrefix,
  stackContainers,
  stackPort,
  type StackService,
} from './stack-ports';

/** Slot 0's ports, written out: the ports a single CI runner has always published. */
const SLOT_0 = {
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

describe('slotPorts', () => {
  it('slot 0 is the CI runner layout', () => {
    expect(slotPorts(0)).toEqual(SLOT_0);
  });

  it('slot 3 moves every host port by 30', () => {
    const p = slotPorts(3);
    expect(p.electrs).toBe(3040);
    expect(p.ord).toBe(8110);
    expect(p.ordStock).toBe(8111);
    expect(p.bitcoindRpc).toBe(18473);
    expect(p.harness).toBe(4530);
    expect(p.app).toBe(4230);
    expect(p.feesStub).toBe(9029);
    expect(p.mariadb).toBe(3336);
  });

  it('gives no two services of slots 0..29 the same port, and stops there', () => {
    expect(MAX_SLOTS_SUPPORTED).toBe(30);
    const seen = new Map<number, string>();
    for (let slot = 0; slot < 30; slot++) {
      for (const [service, port] of Object.entries(slotPorts(slot))) {
        const where = `slot ${slot} ${service}`;
        expect(seen.get(port) ?? where).toBe(where);
        seen.set(port, where);
      }
    }
    expect(seen.size).toBe(30 * Object.keys(SLOT_0).length);
    // Slot 30's app port would be slot 0's harness port.
    expect(() => slotPorts(30)).toThrow('slot 30 is outside 0..29, the slots the port layout supports');
    expect(() => slotPorts(-1)).toThrow('slot -1 is outside 0..29');
    expect(() => slotPorts(1.5)).toThrow('slot 1.5 is outside 0..29');
  });
});

describe('slotPrefix and slotEnv', () => {
  it('slot 0 keeps the compose default prefix, every other slot gets its own', () => {
    expect(slotPrefix(0)).toBe('ordpool-e2e');
    expect(slotPrefix(1)).toBe('ordpool-e2e-s1');
    expect(slotPrefix(12)).toBe('ordpool-e2e-s12');
  });

  it('names the containers per compose file', () => {
    expect(stackContainers('ordpool-e2e-s2', 'regtest')).toEqual({
      bitcoind: 'ordpool-e2e-s2-bitcoind',
      electrs: 'ordpool-e2e-s2-electrs',
      ord: 'ordpool-e2e-s2-cat21-ord',
      ordStock: 'ordpool-e2e-s2-ord-stock',
      mariadb: 'ordpool-e2e-s2-mariadb',
      redis: 'ordpool-e2e-s2-redis',
    });
    expect(stackContainers('ordpool-e2e', 'consumer').bitcoind).toBe('ordpool-e2e-consumer-bitcoind');
  });

  it('exports the slot, the prefix, every host port and the container names', () => {
    expect(slotEnv(2, 'consumer')).toEqual({
      E2E_SLOT: '2',
      E2E_PREFIX: 'ordpool-e2e-s2',
      REGTEST_BITCOIND_CONTAINER: 'ordpool-e2e-s2-consumer-bitcoind',
      REGTEST_ORD_CONTAINER: 'ordpool-e2e-s2-consumer-cat21-ord',
      REGTEST_ORD_STOCK_CONTAINER: 'ordpool-e2e-s2-consumer-ord-stock',
      E2E_BITCOIND_RPC_HOST_PORT: '18463',
      E2E_BITCOIND_P2P_HOST_PORT: '18464',
      E2E_ZMQ_RAWBLOCK_HOST_PORT: '28352',
      E2E_ZMQ_RAWTX_HOST_PORT: '28353',
      E2E_ELECTRS_HOST_PORT: '3030',
      E2E_ELECTRUM_HOST_PORT: '50021',
      E2E_ORD_HOST_PORT: '8100',
      E2E_ORD_STOCK_HOST_PORT: '8101',
      E2E_ORDPOOL_BACKEND_HOST_PORT: '9018',
      E2E_FEES_STUB_PORT: '9019',
      E2E_MARIADB_HOST_PORT: '3326',
      E2E_REDIS_HOST_PORT: '6399',
      E2E_HARNESS_PORT: '4520',
      E2E_APP_PORT: '4220',
      E2E_APP_BACKEND_PORT: '10018',
    });
    expect(slotEnv(0).REGTEST_BITCOIND_CONTAINER).toBe('ordpool-e2e-bitcoind');
  });
});

describe('stackPort', () => {
  it('reads the slot variable, else slot 0', () => {
    expect(stackPort('ord', { E2E_ORD_HOST_PORT: '8100' })).toBe(8100);
    expect(stackPort('ord', {})).toBe(8080);
    expect(stackPort('ord', { E2E_ORD_HOST_PORT: '' })).toBe(8080);
  });

  it('refuses a value that is not a TCP port rather than falling back to slot 0', () => {
    expect(() => stackPort('electrs', { E2E_ELECTRS_HOST_PORT: '30x0' })).toThrow('E2E_ELECTRS_HOST_PORT=30x0 is not a TCP port');
    expect(() => stackPort('electrs', { E2E_ELECTRS_HOST_PORT: '70000' })).toThrow('E2E_ELECTRS_HOST_PORT=70000 is not a TCP port');
  });
});

describe('regtestServiceUrls', () => {
  it('follows the slot environment', () => {
    expect(regtestServiceUrls(slotEnv(2))).toEqual({
      electrs: 'http://localhost:3030',
      ord: 'http://localhost:8100',
      ordStock: 'http://localhost:8101',
      ordpoolBackend: 'http://localhost:9018',
      feesStub: 'http://localhost:9019',
      harness: 'http://localhost:4520',
      app: 'http://localhost:4220',
      appBackend: 'http://localhost:10018',
    });
  });

  it('keeps an explicit REGTEST_*_URL over the slot port', () => {
    const urls = regtestServiceUrls({ ...slotEnv(2), REGTEST_ORD_URL: 'http://ord.regtest.test:18080' });
    expect(urls.ord).toBe('http://ord.regtest.test:18080');
    expect(urls.electrs).toBe('http://localhost:3030');
  });
});

describe('the compose files and scripts', () => {
  const e2eDir = __dirname;
  const files = [
    'docker-compose.regtest.yml',
    'docker-compose.consumer-environment.yml',
  ];
  const envToService = new Map(Object.entries(SLOT_PORT_ENV).map(([s, e]) => [e, s as StackService]));

  it.each(files)('%s publishes only host ports from the slot variables, defaulting to slot 0', (file) => {
    const text = fs.readFileSync(path.join(e2eDir, file), 'utf8');
    const mappings = [...text.matchAll(/^\s*- "([^"]+):(\d+)"/gm)];
    expect(mappings.length).toBeGreaterThan(3);
    for (const [, host] of mappings) {
      const m = /^\$\{(E2E_[A-Z0-9_]+):-(\d+)\}$/.exec(host);
      if (!m) throw new Error(`${file}: host port "${host}" is not \${E2E_*:-<slot 0 port>}`);
      const service = envToService.get(m[1]);
      if (!service) throw new Error(`${file}: ${m[1]} is no slot port variable`);
      expect(`${m[1]}=${m[2]}`).toBe(`${m[1]}=${SLOT_0[service]}`);
    }
  });

  it.each(files)('%s names every container after E2E_PREFIX', (file) => {
    const text = fs.readFileSync(path.join(e2eDir, file), 'utf8');
    const names = [...text.matchAll(/container_name: (\S+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(1);
    for (const n of names) expect(n.startsWith('${E2E_PREFIX:-ordpool-e2e}-') && n).toBe(n);
  });

  it.each(['regtest-bootstrap.sh', 'consumer-environment-bootstrap.sh'])('%s takes its ports from the slot and names none', (file) => {
    const text = fs.readFileSync(path.join(e2eDir, file), 'utf8');
    expect(text).toContain('use_stack_slot');
    const literal = /localhost:\d|:-\d{4}\}/.exec(text);
    expect(literal?.[0] ?? null).toBe(null);
  });
});
