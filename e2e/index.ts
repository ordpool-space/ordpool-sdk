// Public e2e helper surface, compiled to dist-e2e/ (tsconfig.e2e.json) and
// exposed as the `ordpool-sdk/e2e` subpath. Consumers import the wallet
// onboarders + regtest helpers from here instead of copying the raw .ts out of
// node_modules (Node/Playwright won't strip-types .ts under node_modules; the
// compiled JS here needs no transpile step).
//
// @playwright/test is an OPTIONAL peer dep: only importers of this subpath need
// it (the compiled onboarders require it at runtime, resolved from the
// consumer's own copy). Non-testing consumers of ordpool-sdk/core never load
// this file and need nothing.
//
// The regtest HTTP stub (e2e/regtest/fees-electrs-stub.mjs) is NOT part of this
// surface: it is run as a script (`node .../fees-electrs-stub.mjs`), never
// imported, so it stays a plain .mjs shipped in the tarball.
export * from './playwright/onboard-unisat';
export * from './playwright/onboard-wizz';
export * from './playwright/wizz-offline-routes';
export * from './playwright/alby-auto-approve';
export * from './playwright/onboard-leather';
export * from './playwright/onboard-okx';
export * from './playwright/onboard-phantom';
export * from './playwright/onboard-alby';
export * from './playwright/onboard-cat21wallet';
export * from './playwright/onboard-xverse';
export * from './playwright/wallet-onboarders';
export * from './playwright/wallet-test-vectors';
export * from './playwright/approval-popup';
export * from './playwright/wait-helpers';
export * from './playwright/browser-error-guard';
export * from './playwright/radix-checkbox';
export * from './playwright/cat21wallet-sign-popup';
export * from './regtest/regtest-helpers';
