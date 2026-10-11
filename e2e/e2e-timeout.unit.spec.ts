/**
 * @test-kind unit
 * Real:   e2eTimeoutMs, the e2e runner configs (Playwright wallet, Playwright cat21wallet, jest regtest)
 * Faked:  process.env.ORDPOOL_E2E_TIMEOUT_MS, set and restored around each case
 * Proves: the per-wait bound is the runner config's value, a missing or malformed one is an error, never a default,
 *         and every runner config gives its own waits and the SDK helpers the same 30 s bound, separate from the test bound
 */
import { E2E_TIMEOUT_ENV, e2eTimeoutMs } from './e2e-timeout';

describe('e2eTimeoutMs', () => {
  const saved = process.env.ORDPOOL_E2E_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ORDPOOL_E2E_TIMEOUT_MS;
    else process.env.ORDPOOL_E2E_TIMEOUT_MS = saved;
  });

  it('names the variable the runner configs set', () => {
    expect(E2E_TIMEOUT_ENV).toBe('ORDPOOL_E2E_TIMEOUT_MS');
  });

  it('returns the value the runner config set, read at call time', () => {
    process.env.ORDPOOL_E2E_TIMEOUT_MS = '123456';
    expect(e2eTimeoutMs()).toBe(123456);
    process.env.ORDPOOL_E2E_TIMEOUT_MS = '30000';
    expect(e2eTimeoutMs()).toBe(30000);
  });

  it('throws when the variable is not set, naming how to set it', () => {
    delete process.env.ORDPOOL_E2E_TIMEOUT_MS;
    expect(() => e2eTimeoutMs()).toThrow(
      'ORDPOOL_E2E_TIMEOUT_MS is not set. Set it in the runner config to the per-wait bound ' +
        "(process.env.ORDPOOL_E2E_TIMEOUT_MS = String(WAIT_TIMEOUT_MS)); the SDK's polling helpers stop at that bound.",
    );
  });

  it.each(['', 'abc', '0', '-5', '1.5', '60s'])('throws for the malformed value %p', (raw) => {
    process.env.ORDPOOL_E2E_TIMEOUT_MS = raw;
    expect(() => e2eTimeoutMs()).toThrow(`ORDPOOL_E2E_TIMEOUT_MS is "${raw}".`);
  });
});

/** The per-wait bound every e2e runner config sets: a state that needs longer to arrive is a defect. */
const PER_WAIT_BOUND_MS = 30_000;

describe('e2e runner configs', () => {
  const saved = process.env.ORDPOOL_E2E_TIMEOUT_MS;
  beforeEach(() => {
    delete process.env.ORDPOOL_E2E_TIMEOUT_MS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ORDPOOL_E2E_TIMEOUT_MS;
    else process.env.ORDPOOL_E2E_TIMEOUT_MS = saved;
  });

  /**
   * Loads a config the way its runner does. Each config is loaded by exactly one
   * case, after the variable was cleared, so the value read back is the one that
   * config's top-level assignment set.
   */
  function loadConfig<T>(modulePath: string): T {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(modulePath) as { default?: T } & T;
    return mod.default ?? mod;
  }

  interface PlaywrightTimeouts {
    timeout: number;
    expect: { timeout: number };
    use: { actionTimeout: number; navigationTimeout: number };
    webServer: { timeout: number };
  }

  it.each(['./playwright/playwright.config', './playwright/playwright.cat21wallet.config'])(
    '%s bounds every Playwright wait and every SDK helper by the same per-wait bound, and the test separately',
    (modulePath) => {
      const config = loadConfig<PlaywrightTimeouts>(modulePath);
      expect(e2eTimeoutMs()).toBe(PER_WAIT_BOUND_MS);
      expect(config.expect.timeout).toBe(PER_WAIT_BOUND_MS);
      expect(config.use.actionTimeout).toBe(PER_WAIT_BOUND_MS);
      expect(config.use.navigationTimeout).toBe(PER_WAIT_BOUND_MS);
      expect(config.webServer.timeout).toBe(PER_WAIT_BOUND_MS);
      expect(config.timeout).toBeGreaterThan(PER_WAIT_BOUND_MS);
    },
  );

  it('jest.config.regtest bounds every SDK helper by the per-wait bound, and the test separately', () => {
    const config = loadConfig<{ testTimeout: number }>('./jest.config.regtest.js');
    expect(e2eTimeoutMs()).toBe(PER_WAIT_BOUND_MS);
    expect(config.testTimeout).toBeGreaterThan(PER_WAIT_BOUND_MS);
  });
});
