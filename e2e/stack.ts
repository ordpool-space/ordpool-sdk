// The Playwright-free part of the e2e surface, the `ordpool-sdk/e2e/stack`
// subpath: where a regtest stack's services answer (`stackPort`, `stackUrl`,
// `slotEnv`, ...), the per-wait bound (`e2eTimeoutMs`) and the bitcoind wallet
// name (`regtestWallet`). For code that must not load @playwright/test, such
// as a backend's jest specs or a seeding script; `ordpool-sdk/e2e` re-exports
// the same bindings beside the browser helpers.
//
// Nothing reachable from here may import @playwright/test: a spec loads this
// file in a fresh process and fails when it does.
export * from './e2e-timeout';
export * from './regtest-wallet';
export * from './stack-ports';