// Captured responses for test doubles, as the `ordpool-sdk/testing` subpath.
//
// A lean barrel with a CommonJS emit behind its `require` condition, so a test
// helper running under Node loads it without the wallet-connector graph that
// `/core` carries. The `ordpool-sdk/e2e` wallet shields answer a wallet's fee
// lookup from here; `/core` and the main entry re-export the same module, so
// there is one fixture and every consumer reads it.
//
// It also carries pure builders for spec inputs that need a real signature
// (`buildSignedTestBuyOffer`, `signTestBip322Message`): `@scure` and `@noble`
// only, so they run in Node and in a browser.
export * from './cat21-mint/recommended-fees.fixtures.js';
export * from './cat21-ord/cats-at-output.fixtures.js';
export * from './testing/buy-offer-psbt.js';
export * from './testing/bip322-signer.js';
