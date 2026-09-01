"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForSingletonLockGone = waitForSingletonLockGone;
exports.waitForServiceWorkerReady = waitForServiceWorkerReady;
exports.waitForChromeStorageKey = waitForChromeStorageKey;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
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
async function waitForSingletonLockGone(userDataDir, timeoutMs = 30_000) {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    const stillThere = () => lockFiles.some(f => fs.existsSync(path.join(userDataDir, f)));
    // Poll rather than fs.watch: fs.watch has a check-then-watch race (a lock
    // removed between the initial stillThere() and arming the watcher is missed,
    // and the caller then eats the full timeout) and silently drops events on
    // some platforms. A 100ms poll has no such gap.
    const deadline = Date.now() + timeoutMs;
    while (stillThere()) {
        if (Date.now() > deadline) {
            throw new Error(`SingletonLock still present in ${userDataDir} after ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}
/**
 * Wait for a context's service worker to be responsive after a
 * `chrome.runtime.reload()`. The OLD worker reference is dead post-
 * reload; the new one materialises in `context.serviceWorkers()`
 * shortly after. We probe with `chrome.storage.local.get` against
 * whichever SW the context currently exposes; the loop is naturally
 * throttled by the RPC round-trip and yields via setImmediate so
 * the event loop can flush in between checks.
 */
async function waitForServiceWorkerReady(context, options = {}) {
    const opts = typeof options === 'number' ? { timeoutMs: options } : options;
    const ignoreWorker = opts.ignoreWorker;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // Two parallel observation paths converge on the same outcome:
    //
    //   (a) Playwright's `serviceworker` event fires when a new SW
    //       registers. chrome.runtime.reload() unregisters the old SW
    //       then re-registers, so this fires for the restarted SW.
    //   (b) Probe loop against context.serviceWorkers()[0] — for the
    //       case where Chromium re-registers the SW silently from
    //       Playwright's CDP perspective (observed on some
    //       chromium-headed-extension builds: the SW exists in the
    //       browser but no fresh `serviceworker` event surfaces).
    //
    // Promise.any returns the first fulfilled value; AggregateError
    // only if BOTH paths exhaust their independent timeouts. The
    // `ignoreWorker` option lets callers pin out a known-dead reference
    // — e.g. the SW that hosted chrome.runtime.reload() and is gone.
    const isFresh = (w) => !ignoreWorker || w !== ignoreWorker;
    return Promise.any([
        context.waitForEvent('serviceworker', {
            timeout: timeoutMs,
            predicate: isFresh,
        }),
        (async () => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const w = context.serviceWorkers().find(isFresh);
                if (w) {
                    try {
                        await w.evaluate(() => chrome.storage.local.get('__sw_health_check__'));
                        return w;
                    }
                    catch { /* worker stale; loop */ }
                }
                await new Promise(resolve => setImmediate(resolve));
            }
            throw new Error('probe path exhausted');
        })(),
    ]);
}
/**
 * Wait until a key matching `keyContains` is observable in the
 * extension's `chrome.storage.local`. Used to gate on async writes
 * that happen inside the wallet's service worker — e.g. redux-
 * persist's debounced flush after a UI close. Polls via the SW's
 * `evaluate()` round-trip, which is naturally throttled by the IPC
 * latency (no in-loop setTimeout sleep).
 */
async function waitForChromeStorageKey(opts) {
    const { context, keyContains } = opts;
    const matchValue = opts.matchValue;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    // Re-fetch the SW reference on every iteration — chrome.runtime.reload()
    // may have invalidated whichever worker was current at call time.
    // Each evaluate() throws "target closed" while the SW restarts;
    // catching and retrying lets the loop ride out the restart without
    // any hardcoded sleep.
    while (Date.now() < deadline) {
        const [worker] = context.serviceWorkers();
        if (worker) {
            try {
                const found = await worker.evaluate(async ({ keyContains: kc }) => {
                    const all = await chrome.storage.local.get(null);
                    const key = Object.keys(all).find(k => k.includes(kc));
                    if (!key)
                        return null;
                    return { key, value: all[key] };
                }, { keyContains });
                if (found && (!matchValue || matchValue(found.value)))
                    return;
            }
            catch { /* SW restarting; retry on next iteration */ }
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`chrome.storage.local never produced a key containing "${keyContains}" within ${timeoutMs}ms`);
}
//# sourceMappingURL=wait-helpers.js.map