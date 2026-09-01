import type { BrowserContext, Worker } from '@playwright/test';
/**
 * Wait until a Chromium persistent-context's `SingletonLock` (and
 * friends) are gone from the user-data-dir. After `context.close()`,
 * Chromium may still be writing to its profile for a beat; touching
 * the directory before that beat ends races with the OS and leaves
 * stale lock files that prevent re-launch.
 *
 * Event-driven via fs.watch — fires on the deletion event. The
 * `timeoutMs` argument is the deadline, not a poll interval; the
 * Promise rejects if no deletion arrives in that window.
 */
export declare function waitForSingletonLockGone(userDataDir: string, timeoutMs?: number): Promise<void>;
/**
 * Wait for a context's service worker to be responsive after a
 * `chrome.runtime.reload()`. The OLD worker reference is dead post-
 * reload; the new one materialises in `context.serviceWorkers()`
 * shortly after. We probe with `chrome.storage.local.get` against
 * whichever SW the context currently exposes; the loop is naturally
 * throttled by the RPC round-trip and yields via setImmediate so
 * the event loop can flush in between checks.
 */
export declare function waitForServiceWorkerReady(context: BrowserContext, options?: {
    ignoreWorker?: Worker;
    timeoutMs?: number;
} | number): Promise<Worker>;
/**
 * Wait until a key matching `keyContains` is observable in the
 * extension's `chrome.storage.local`. Used to gate on async writes
 * that happen inside the wallet's service worker — e.g. redux-
 * persist's debounced flush after a UI close. Polls via the SW's
 * `evaluate()` round-trip, which is naturally throttled by the IPC
 * latency (no in-loop setTimeout sleep).
 */
export declare function waitForChromeStorageKey(opts: {
    context: BrowserContext;
    /** Substring of the key we wait to see (e.g. 'walletState'). */
    keyContains: string;
    /** Optional: caller-supplied predicate on the resolved value. */
    matchValue?: (value: unknown) => boolean;
    timeoutMs?: number;
}): Promise<void>;
//# sourceMappingURL=wait-helpers.d.ts.map