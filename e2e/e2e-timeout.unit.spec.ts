/**
 * @test-kind unit
 * Real:   e2eTimeoutMs
 * Faked:  process.env.ORDPOOL_E2E_TIMEOUT_MS, set and restored around each case
 * Proves: the global bound is the runner config's value, and a missing or malformed one is an error, never a default
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
    process.env.ORDPOOL_E2E_TIMEOUT_MS = '600000';
    expect(e2eTimeoutMs()).toBe(600000);
  });

  it('throws when the variable is not set, naming how to set it', () => {
    delete process.env.ORDPOOL_E2E_TIMEOUT_MS;
    expect(() => e2eTimeoutMs()).toThrow(
      'ORDPOOL_E2E_TIMEOUT_MS is not set. Set it in the runner config to the same value as the test timeout ' +
        "(process.env.ORDPOOL_E2E_TIMEOUT_MS = String(TIMEOUT_MS)); the SDK's polling helpers stop at that bound.",
    );
  });

  it.each(['', 'abc', '0', '-5', '1.5', '60s'])('throws for the malformed value %p', (raw) => {
    process.env.ORDPOOL_E2E_TIMEOUT_MS = raw;
    expect(() => e2eTimeoutMs()).toThrow(`ORDPOOL_E2E_TIMEOUT_MS is "${raw}".`);
  });
});
