/**
 * The readiness contract: "connected" and "safe to act on" are different
 * questions, and conflating them is what produces a dead first click.
 *
 * `connectedWallet$` emits from two places. A fresh connect, where the
 * extension has demonstrably answered. And `restoreFromStorage` on page load,
 * which emits a persisted identity synchronously out of localStorage, before
 * the extension has necessarily injected its provider. A consumer that renders
 * "connected" off that second emission and acts on the next click reaches for a
 * provider that is not there yet.
 *
 * jsdom rather than node, because the thing under test is whether a provider
 * has appeared on `window`, and that only exists in a browser environment.
 */

import { BehaviorSubject } from 'rxjs';

import { Network } from '../network.js';
import { StorageLike } from '../storage-like.js';
import { WalletService } from './wallet.service.js';
import { KnownOrdinalWalletType, WalletInfo, WalletReadiness } from './wallet.service.types.js';

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getValue: (k: string) => map.get(k) ?? null,
    setValue: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  } as unknown as StorageLike;
}

const unisatWallet: WalletInfo = {
  type: KnownOrdinalWalletType.unisat,
  ordinalsAddress: 'bc1p0000000000000000000000000000000000000000000000000000000000',
  ordinalsPublicKey: '02'.padEnd(66, '0'),
  paymentAddress: 'bc1q000000000000000000000000000000000000000',
  paymentPublicKey: '02'.padEnd(66, '0'),
  signingSupported: true,
};

const xpubWallet: WalletInfo = { ...unisatWallet, type: KnownOrdinalWalletType.xpub };

function makeService(): WalletService {
  return new WalletService({ storage: memoryStorage(), network: Network.Mainnet });
}

/** Collects every state the contract reports, in order. */
function record(service: WalletService): WalletReadiness[] {
  const seen: WalletReadiness[] = [];
  service.walletReadiness$.subscribe(r => seen.push(r));
  return seen;
}

describe('walletReadiness$', () => {

  beforeEach(() => {
    jest.useFakeTimers();
    delete (window as unknown as { unisat?: unknown }).unisat;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (window as unknown as { unisat?: unknown }).unisat;
  });

  it('reports disconnected when nobody is connected', () => {
    const seen = record(makeService());
    expect(seen).toEqual([{ state: 'disconnected' }]);
  });

  it('is READY immediately for watch-only, which has no provider to wait for', () => {
    // xpub is not in walletConnectors at all, so a readiness check that reaches
    // for its connector throws, and one that waits for a provider leaves every
    // hardware-wallet user hydrating forever. Both are silent failures.
    const service = makeService();
    const seen = record(service);
    service.connectedWallet$.next(xpubWallet);

    expect(seen.map(r => r.state)).toEqual(['disconnected', 'ready']);
  });

  it('is READY with no hydrating tick when the provider is already injected', () => {
    // The fresh-connect case: the extension answered, so there is nothing to
    // wait for and a consumer should not have to debounce a transient state.
    (window as unknown as { unisat: unknown }).unisat = {};
    const service = makeService();
    const seen = record(service);
    service.connectedWallet$.next(unisatWallet);

    expect(seen.map(r => r.state)).toEqual(['disconnected', 'ready']);
  });

  it('goes HYDRATING then READY when the provider is injected late', () => {
    // The actual bug. Identity restored from storage at t=0, extension injects
    // at t=250ms. Without this contract a consumer acts in that window and the
    // click does nothing.
    const service = makeService();
    const seen = record(service);
    service.connectedWallet$.next(unisatWallet);

    expect(seen.map(r => r.state)).toEqual(['disconnected', 'hydrating']);

    // The load-bearing assertion: STILL hydrating while the provider is
    // absent, across several poll ticks. Without this the test passes for a
    // contract that reports ready on the first tick regardless of whether
    // anything is there, which is the bug with extra steps.
    jest.advanceTimersByTime(250);
    expect(seen.map(r => r.state)).toEqual(['disconnected', 'hydrating']);

    (window as unknown as { unisat: unknown }).unisat = {};
    jest.advanceTimersByTime(200);

    expect(seen.map(r => r.state)).toEqual(['disconnected', 'hydrating', 'ready']);
    const ready = seen[2];
    if (ready.state !== 'ready') throw new Error('expected ready');
    expect(ready.wallet).toBe(unisatWallet);
  });

  it('ends UNREACHABLE, not hydrating forever, when the provider never appears', () => {
    // Fails toward action: the extension is disabled, removed or broken, and
    // the consumer needs to offer a reconnect rather than spin. A contract that
    // stalls in `hydrating` is a dead click with extra steps.
    const service = makeService();
    const seen = record(service);
    service.connectedWallet$.next(unisatWallet);

    jest.advanceTimersByTime(5_000);

    expect(seen.map(r => r.state)).toEqual(['disconnected', 'hydrating', 'unreachable']);
    const last = seen[2];
    if (last.state !== 'unreachable') throw new Error('expected unreachable');
    expect(last.wallet).toBe(unisatWallet);
    // The reason names the wallet and the ceiling, so a bug report is legible.
    expect(last.reason).toContain(KnownOrdinalWalletType.unisat);
    expect(last.reason).toContain('3000');
  });

  it('stops polling once it has settled, rather than flapping', () => {
    const service = makeService();
    const seen = record(service);
    service.connectedWallet$.next(unisatWallet);
    jest.advanceTimersByTime(5_000);
    const settled = seen.length;

    // A provider appearing after the contract gave up must not resurrect the
    // stream: the consumer has already been told to offer a reconnect.
    (window as unknown as { unisat: unknown }).unisat = {};
    jest.advanceTimersByTime(5_000);

    expect(seen.length).toBe(settled);
  });
});
