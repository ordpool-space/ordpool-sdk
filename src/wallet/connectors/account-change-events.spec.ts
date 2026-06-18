/**
 * Pins the `onAccountChange` wiring for the four event-supporting
 * connectors (unisat, wizz, okx, binance). The wallet exposes
 * accountsChanged + networkChanged (OKX: accountChanged singular);
 * both must fan into the single SDK callback so consumers can
 * invalidate caches on any change axis.
 */

import { describe, expect, it } from '@jest/globals';

import { unisatConnector } from './unisat.connector';
import { wizzConnector } from './wizz.connector';
import { okxConnector } from './okx.connector';
import { binanceConnector } from './binance.connector';

interface MockProvider {
  on: (event: string, handler: () => void) => void;
  removeListener: (event: string, handler: () => void) => void;
}

function makeMockProvider() {
  const listeners: Array<{ event: string; handler: () => void }> = [];
  const provider: MockProvider = {
    on: (event, handler) => { listeners.push({ event, handler }); },
    removeListener: (event, handler) => {
      const idx = listeners.findIndex(l => l.event === event && l.handler === handler);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };
  return { provider, listeners };
}

/**
 * Run `fn` with `window.<key>` temporarily set per `stub`, then
 * restore. In node we install a synthetic global window; in jsdom we
 * patch keys on the existing one (jsdom's `window` is a real object
 * and resolves separately from `globalThis.window`).
 */
function withWindow<T>(stub: Record<string, unknown>, fn: () => T): T {
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  if (w.window === undefined) {
    w.window = stub;
    try { return fn(); } finally { delete w.window; }
  }
  const target = w.window;
  const saved = new Map<string, unknown>();
  for (const [key, value] of Object.entries(stub)) {
    saved.set(key, target[key]);
    target[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete target[key]; else target[key] = prev;
    }
  }
}

describe('onAccountChange wiring', () => {

  describe('unisat', () => {

    it('registers both accountsChanged and networkChanged when the provider exposes on/removeListener', () => {
      const { provider, listeners } = makeMockProvider();
      withWindow({ unisat: provider }, () => {
        const unsubscribe = unisatConnector.onAccountChange!(() => undefined);
        expect(listeners.map(l => l.event).sort()).toEqual(['accountsChanged', 'networkChanged']);
        unsubscribe();
        expect(listeners).toEqual([]);
      });
    });

    it('fires the SDK callback when EITHER event fires (no separate accountsChanged-only path)', () => {
      const { provider, listeners } = makeMockProvider();
      withWindow({ unisat: provider }, () => {
        let calls = 0;
        unisatConnector.onAccountChange!(() => { calls++; });
        listeners.find(l => l.event === 'accountsChanged')!.handler();
        listeners.find(l => l.event === 'networkChanged')!.handler();
        expect(calls).toBe(2);
      });
    });

    it('returns a no-op unsubscribe when the provider does not expose on() (older binaries)', () => {
      withWindow({ unisat: { requestAccounts: async () => undefined } }, () => {
        const unsubscribe = unisatConnector.onAccountChange!(() => undefined);
        expect(() => unsubscribe()).not.toThrow();
      });
    });
  });

  describe('wizz', () => {

    it('mirrors the unisat shape (same event names; provider at window.wizz)', () => {
      const { provider, listeners } = makeMockProvider();
      withWindow({ wizz: provider }, () => {
        let calls = 0;
        const unsubscribe = wizzConnector.onAccountChange!(() => { calls++; });
        expect(listeners.map(l => l.event).sort()).toEqual(['accountsChanged', 'networkChanged']);
        listeners[0].handler();
        listeners[1].handler();
        expect(calls).toBe(2);
        unsubscribe();
        expect(listeners).toEqual([]);
      });
    });
  });

  describe('okx', () => {

    it('subscribes to accountChanged (singular) + networkChanged on window.okxwallet.bitcoin', () => {
      const { provider, listeners } = makeMockProvider();
      withWindow({ okxwallet: { bitcoin: provider } }, () => {
        let calls = 0;
        const unsubscribe = okxConnector.onAccountChange!(() => { calls++; });
        expect(listeners.map(l => l.event).sort()).toEqual(['accountChanged', 'networkChanged']);
        listeners[0].handler();
        listeners[1].handler();
        expect(calls).toBe(2);
        unsubscribe();
        expect(listeners).toEqual([]);
      });
    });

    it('returns a no-op unsubscribe when okxwallet.bitcoin is absent (the v1.17.2-shaped case)', () => {
      withWindow({}, () => {
        const unsubscribe = okxConnector.onAccountChange!(() => undefined);
        expect(() => unsubscribe()).not.toThrow();
      });
    });
  });

  describe('binance', () => {

    it('subscribes when window.binancew3w.bitcoin exposes on/removeListener', () => {
      const { provider, listeners } = makeMockProvider();
      withWindow({ binancew3w: { bitcoin: provider } }, () => {
        let calls = 0;
        const unsubscribe = binanceConnector.onAccountChange!(() => { calls++; });
        expect(listeners.map(l => l.event).sort()).toEqual(['accountsChanged', 'networkChanged']);
        listeners[0].handler();
        listeners[1].handler();
        expect(calls).toBe(2);
        unsubscribe();
        expect(listeners).toEqual([]);
      });
    });

    it('returns a no-op unsubscribe when binancew3w.bitcoin is absent (current binary)', () => {
      withWindow({ binancew3w: {} }, () => {
        const unsubscribe = binanceConnector.onAccountChange!(() => undefined);
        expect(() => unsubscribe()).not.toThrow();
      });
    });
  });
});
