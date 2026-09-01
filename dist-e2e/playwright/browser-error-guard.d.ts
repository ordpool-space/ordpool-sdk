import type { BrowserContext } from '@playwright/test';
/**
 * Install a context-level guard that captures uncaught JS exceptions
 * and `console.error` surfaces from every OUR-APP page the context
 * spawns. Any unfiltered browser-side error becomes a test failure
 * per E2E_BEST_PRACTICES.md rule 11.
 *
 * The guard hooks `context.on('page', …)` so tests don't need to
 * know about it at page-creation sites. Wallet-extension pages
 * (chrome-extension://…) are IGNORED — those bundles carry their
 * own JS errors (extension-side promise handling, wallet SPA
 * hydration warnings) that have nothing to do with our app and
 * would otherwise cascade-fail every test that briefly touches the
 * extension.
 *
 * Filters (kept narrow, all justified inline):
 * - console warnings and info/log/debug levels are ignored; only
 *   `error` and `pageerror` surface here.
 * - specific expected regtest noise can be added via the `ignore`
 *   regex list; keep it tiny and audit every entry when adding.
 *
 * Twin file lives at
 * ~/Work/ordpool/cat21-indexer/frontend/e2e/regtest/lib/browser-error-guard.ts;
 * keep them in step. Per-repo filter lists diverge only where a
 * stack has genuinely different console noise.
 */
export declare function installContextErrorGuard(context: BrowserContext, options?: {
    ignore?: readonly RegExp[];
}): {
    resetPerTest: () => void;
    assertClean: () => void;
};
//# sourceMappingURL=browser-error-guard.d.ts.map