/**
 * @test-kind unit
 * Real:   e2eExpect over Playwright's own expect and its toBeVisible matcher, clickRadixCheckbox (an SDK helper that
 *         asserts through it), boundByE2eTimeout; all run outside any Playwright test, the way a consumer's
 *         globalSetup runs them
 * Faked:  the checkbox locator, reduced to what Playwright's matcher calls on a Locator (playwright 1.60
 *         lib/matchers/expect.js): `_apiName` (its type check), `_expect(expression, { isNot, timeout })` (the call
 *         to the browser, which waits up to `timeout` and answers `timedOut`) and `toString`; the context whose
 *         two default-timeout setters are recorded
 * Proves: outside a test an SDK helper's assertion gives up at ORDPOOL_E2E_TIMEOUT_MS, not at Playwright's built-in
 *         5 s, reading the bound at each call, and boundByE2eTimeout sets both defaults of a context to the bound
 */
import { clickRadixCheckbox } from './radix-checkbox';
import { boundByE2eTimeout, e2eExpect } from './e2e-expect';

/** Playwright's Locator type, named without importing @playwright/test into a unit spec. */
type Locator = ReturnType<Parameters<typeof clickRadixCheckbox>[0]['getByRole']>;

/** A locator that is never visible: each `_expect` answers once the timeout it is given has passed, as the browser does. */
function neverVisible() {
  const timeouts: number[] = [];
  const locator = {
    _apiName: 'Locator',
    timeouts,
    toString: () => "getByRole('checkbox').nth(0)",
    _expect(_expression: string, options: { isNot: boolean; timeout: number }) {
      timeouts.push(options.timeout);
      const answer = { matches: false, timedOut: true, log: [], received: { value: false } };
      return new Promise<typeof answer>((resolve) => setTimeout(() => resolve(answer), options.timeout));
    },
  };
  return locator;
}

/** A page whose only checkbox is `locator`. */
function pageWith(locator: ReturnType<typeof neverVisible>) {
  return { getByRole: () => ({ nth: () => locator }) };
}

let before: string | undefined;
beforeEach(() => { before = process.env.ORDPOOL_E2E_TIMEOUT_MS; });
afterEach(() => { process.env.ORDPOOL_E2E_TIMEOUT_MS = before; });

describe('an SDK helper outside a test', () => {
  it('gives up at ORDPOOL_E2E_TIMEOUT_MS, not at Playwright\'s built-in 5 s', async () => {
    process.env.ORDPOOL_E2E_TIMEOUT_MS = '300';
    const locator = neverVisible();
    const started = Date.now();
    const err = await clickRadixCheckbox(pageWith(locator) as never).then(() => null, (e: Error) => e);
    const elapsed = Date.now() - started;
    expect(locator.timeouts).toEqual([300]);
    expect(err?.message).toMatch(/Timeout: +300ms/);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('reads the bound at each call', async () => {
    const locator = neverVisible();
    process.env.ORDPOOL_E2E_TIMEOUT_MS = '120';
    await expect(e2eExpect(locator as unknown as Locator).toBeVisible()).rejects.toThrow(/Timeout: +120ms/);
    process.env.ORDPOOL_E2E_TIMEOUT_MS = '250';
    await expect(e2eExpect(locator as unknown as Locator).toBeVisible()).rejects.toThrow(/Timeout: +250ms/);
    expect(locator.timeouts).toEqual([120, 250]);
  });
});

describe('boundByE2eTimeout', () => {
  it('sets the action and the navigation default to the bound', () => {
    process.env.ORDPOOL_E2E_TIMEOUT_MS = '4321';
    const set: string[] = [];
    boundByE2eTimeout({
      setDefaultTimeout(ms: number) { set.push(`action ${ms}`); },
      setDefaultNavigationTimeout(ms: number) { set.push(`navigation ${ms}`); },
    });
    expect(set).toEqual(['action 4321', 'navigation 4321']);
  });
});
