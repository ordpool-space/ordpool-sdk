/**
 * @test-kind unit
 * Real:   regtestWallet; the BUILT `ordpool-sdk/e2e/stack` and `ordpool-sdk/e2e` subpaths, required by package name
 *         in a fresh node process through the package's own `exports` map, the way a consumer's jest resolves them
 * Faked:  nothing; each environment is a plain object passed in
 * Proves: the wallet name follows REGTEST_WALLET with the bootstraps' default, and the stack subpath serves the
 *         wallet name, the slot ports and the wait bound without loading @playwright/test, while `ordpool-sdk/e2e`
 *         serves the same bindings
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { regtestWallet } from './regtest-wallet';

describe('regtestWallet', () => {
  it('is ordpool-e2e when REGTEST_WALLET is unset or empty, as in the bootstraps', () => {
    expect(regtestWallet({})).toBe('ordpool-e2e');
    expect(regtestWallet({ REGTEST_WALLET: '' })).toBe('ordpool-e2e');
  });

  it('follows REGTEST_WALLET', () => {
    expect(regtestWallet({ REGTEST_WALLET: 'cubes-e2e' })).toBe('cubes-e2e');
  });
});

/**
 * Requires `specifier` from the package root in a fresh node process, recording every module request, and
 * prints what a consumer reads from it.
 */
function loadInFreshProcess(specifier: string): { loadedPlaywright: string[]; wallet: string; electrsUrl: string; bound: number; exported: string[]; boundedHelpers: string[] } {
  const script = `
    const Module = require('node:module');
    const requested = [];
    const load = Module._load;
    Module._load = function (request, ...rest) { requested.push(request); return load.call(this, request, ...rest); };
    const m = require(${JSON.stringify(specifier)});
    process.stdout.write(JSON.stringify({
      loadedPlaywright: [...new Set(requested.filter((r) => /^@?playwright(-core)?(\\/|$)/.test(r)))],
      wallet: m.regtestWallet(),
      electrsUrl: m.stackUrl('electrs'),
      bound: m.e2eTimeoutMs(),
      exported: ['regtestWallet', 'DEFAULT_REGTEST_WALLET', 'REGTEST_WALLET_ENV', 'stackPort', 'stackUrl', 'slotEnv', 'e2eTimeoutMs']
        .filter((k) => k in m),
      boundedHelpers: ['e2eExpect', 'boundByE2eTimeout'].filter((k) => typeof m[k] === 'function'),
    }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REGTEST_WALLET: 'consumer-wallet', E2E_ELECTRS_HOST_PORT: '3020', ORDPOOL_E2E_TIMEOUT_MS: '1234' },
  });
  if (r.status !== 0) throw new Error(`node exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('the ordpool-sdk/e2e/stack subpath', () => {
  const all = ['regtestWallet', 'DEFAULT_REGTEST_WALLET', 'REGTEST_WALLET_ENV', 'stackPort', 'stackUrl', 'slotEnv', 'e2eTimeoutMs'];

  it('serves the wallet name, the slot ports and the wait bound without loading Playwright', () => {
    expect(loadInFreshProcess('ordpool-sdk/e2e/stack')).toEqual({
      loadedPlaywright: [],
      wallet: 'consumer-wallet',
      electrsUrl: 'http://localhost:3020',
      bound: 1234,
      exported: all,
      boundedHelpers: [],
    });
  });

  it('serves the same bindings as ordpool-sdk/e2e, which does load Playwright', () => {
    const e2e = loadInFreshProcess('ordpool-sdk/e2e');
    expect([e2e.wallet, e2e.electrsUrl, e2e.bound, e2e.exported]).toEqual(['consumer-wallet', 'http://localhost:3020', 1234, all]);
    expect(e2e.loadedPlaywright).toContain('@playwright/test');
  });

  it('ordpool-sdk/e2e also exports the helpers that bound a wait outside a test', () => {
    expect(loadInFreshProcess('ordpool-sdk/e2e').boundedHelpers).toEqual(['e2eExpect', 'boundByE2eTimeout']);
  });
});
