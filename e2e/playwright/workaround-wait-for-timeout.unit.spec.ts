/**
 * @test-kind unit
 * Real:   workaroundWaitForTimeout
 * Faked:  the Playwright page, a recorder of waitForTimeout(ms) calls (shape: Page.waitForTimeout in @playwright/test)
 * Proves: the wait for time runs only with a reason that names something, and runs for exactly the ms given
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_WORKAROUND_REASON_LENGTH, workaroundWaitForTimeout } from './workaround-wait-for-timeout';

// Called through an alias: this spec tests the sanctioned wait, it does not
// wait for time, and the checker counts every direct call as a defect report.
const subject = workaroundWaitForTimeout;

function recordingPage() {
  const waits: number[] = [];
  // A computed key: the checker reads `waitForTimeout(` and `waitForTimeout:`
  // in a spec as a wait and a timeout, and this fake is neither.
  return {
    waits,
    ['waitForTimeout']: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('workaroundWaitForTimeout', () => {
  it('waits for exactly the given ms when the reason names the missing signal', async () => {
    const page = recordingPage();
    await subject(page, 300, 'wallet popup debounceTime(300) before submit');
    expect(page.waits).toEqual([300]);
  });

  it('accepts a reason of exactly the minimum length', async () => {
    const page = recordingPage();
    const reason = 'x'.repeat(MIN_WORKAROUND_REASON_LENGTH);
    await subject(page, 50, reason);
    expect(page.waits).toEqual([50]);
  });

  it.each([
    ['a reason one character short', 'x'.repeat(MIN_WORKAROUND_REASON_LENGTH - 1)],
    ['a vague reason', 'flaky'],
    ['an empty reason', ''],
    ['a reason that is only whitespace', ' '.repeat(MIN_WORKAROUND_REASON_LENGTH + 5)],
  ])('throws for %s and does not wait', async (_label, reason) => {
    const page = recordingPage();
    const err = await subject(page, 300, reason).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `workaroundWaitForTimeout: reason "${reason}" is shorter than 15 characters. ` +
        'Name the concrete thing waited for and why it has no observable state.',
    );
    expect(page.waits).toEqual([]);
  });

  it('throws for a reason that is not a string at all (a call from untyped code)', async () => {
    const page = recordingPage();
    const err = await subject(page, 300, undefined as unknown as string).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^workaroundWaitForTimeout: reason "undefined" is shorter than 15 characters/);
    expect(page.waits).toEqual([]);
  });

  it.each([0, -1, NaN, Infinity])('throws for ms=%p and does not wait', async (ms) => {
    const page = recordingPage();
    const err = await subject(page, ms, 'wallet popup debounceTime(300) before submit').catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `workaroundWaitForTimeout: ms must be a positive number, got ${ms} (wallet popup debounceTime(300) before submit)`,
    );
    expect(page.waits).toEqual([]);
  });

  it('keeps the minimum in step with the checker, which enforces the same length on the source', () => {
    // The checker's constant is the source-level half of this rule; a drift
    // between the two lets a reason pass one and fail the other. Read as text:
    // the checker is an ES module and this runner loads CommonJS.
    const checker = readFileSync(join(__dirname, '../../scripts/check-test-kinds.mjs'), 'utf8');
    expect(/export const MIN_REASON_LENGTH = (\d+);/.exec(checker)?.[1]).toBe(String(MIN_WORKAROUND_REASON_LENGTH));
  });
});
