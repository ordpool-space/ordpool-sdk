/**
 * @test-kind unit
 * Real:   installTabState, markWalletBackgroundInitialised, walletBackgroundInitialisedAt, INSTALL_TAB_SETTLED
 * Faked:  the BrowserContext (only its identity is used, as a WeakMap key)
 * Proves: the install-tab wait settles on a booted tab or on a background that initialised one probe ago without opening one, and on nothing else
 */
import type { BrowserContext } from '@playwright/test';

import {
  INSTALL_TAB_PROBE_MS,
  INSTALL_TAB_SETTLED,
  installTabState,
  markWalletBackgroundInitialised,
  walletBackgroundInitialisedAt,
} from './unisat-install-tab';

const ID = 'okbifngkieadljgngalaodnfanphojhh';
const INDEX = `chrome-extension://${ID}/index.html`;
const INIT = 1_791_800_937_000;

function state(otherPageUrls: string[], initialisedAt: number | undefined, now = INIT + 10 * INSTALL_TAB_PROBE_MS) {
  return installTabState({ extensionId: ID, otherPageUrls, initialisedAt, now });
}

describe('installTabState', () => {
  it('is booted once a tab of the extension left the root route for a screen', () => {
    expect(state(['about:blank', `${INDEX}#/main`], undefined)).toBe('booted');
    expect(state([`${INDEX}#/welcome`], INIT, INIT)).toBe('booted');
  });

  it('is booting while the tab is on index.html or its root route, whatever the background did', () => {
    expect(state([INDEX], INIT)).toBe('booting');
    expect(state([`${INDEX}#/`], INIT)).toBe('booting');
    expect(state(['about:blank', `${INDEX}#/`], undefined)).toBe('booting');
  });

  it('ignores pages that are not the install tab', () => {
    // run 38234775581: the persistent context's own about:blank, the approval
    // window, another extension's index.html and the dapp
    const others = [
      'about:blank',
      `chrome-extension://${ID}/notification.html#/approval`,
      'chrome-extension://bpodjnfppbdiipgbpncgdamadgbbikag/index.html#/main',
      'http://localhost:4200/cat21-mint',
      `${INDEX}.map`,
    ];
    expect(state(others, undefined)).toBe('background-initialising');
  });

  it('is background-initialising while no tab exists and the background has not finished initialising', () => {
    expect(state(['about:blank'], undefined)).toBe('background-initialising');
  });

  it('is poll-pending from the background init until one probe has passed', () => {
    expect(state(['about:blank'], INIT, INIT)).toBe('poll-pending');
    expect(state(['about:blank'], INIT, INIT + INSTALL_TAB_PROBE_MS - 1)).toBe('poll-pending');
  });

  it('is never-opens once a probe has passed since the background init without a tab', () => {
    // run 38234775581: init at 3.6 s, onboarding done at 7.9 s, no install tab
    expect(state(['about:blank'], INIT, INIT + INSTALL_TAB_PROBE_MS)).toBe('never-opens');
    expect(state(['about:blank'], INIT, INIT + 4_300)).toBe('never-opens');
  });

  it('a tab that opens after never-opens counts again', () => {
    expect(state([`${INDEX}#/`], INIT, INIT + 60_000)).toBe('booting');
  });
});

describe('INSTALL_TAB_SETTLED', () => {
  it('is exactly booted and never-opens', () => {
    expect([...INSTALL_TAB_SETTLED].sort()).toEqual(['booted', 'never-opens']);
  });
});

describe('markWalletBackgroundInitialised', () => {
  it('keeps the first time per context and nothing for a context it never saw', () => {
    const a = {} as BrowserContext;
    const b = {} as BrowserContext;
    expect(walletBackgroundInitialisedAt(a)).toBeUndefined();
    markWalletBackgroundInitialised(a, INIT);
    markWalletBackgroundInitialised(a, INIT + 5_000);
    expect(walletBackgroundInitialisedAt(a)).toBe(INIT);
    expect(walletBackgroundInitialisedAt(b)).toBeUndefined();
  });

  it('defaults to now', () => {
    const c = {} as BrowserContext;
    const before = Date.now();
    markWalletBackgroundInitialised(c);
    const at = walletBackgroundInitialisedAt(c);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});
