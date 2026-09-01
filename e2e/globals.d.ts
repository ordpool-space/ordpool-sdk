// Ambient `chrome` for the extension-context `page.evaluate` callbacks in the
// e2e helpers: those bodies execute in the browser (where `chrome` exists), but
// the build:e2e tsc pass type-checks them in the node context. Declared `any`
// because the only touches are `chrome.storage` / `chrome.runtime` inside
// evaluate. Scoped to the build:e2e compilation (tsconfig.e2e.json) only.
declare const chrome: any;
