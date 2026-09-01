"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PASSWORD_BY_WALLET = exports.LEATHER_FAMILY_PASSWORD = exports.SIMPLE_PASSWORD = exports.TEST_MNEMONIC_WORDS = exports.TEST_MNEMONIC = void 0;
// Shared BIP-39 test vector + per-wallet onboarding password for the wallet
// E2E specs AND the local regtest wallet-runner. Centralized so the seed and
// password aren't re-declared at the top of ~40 spec files.
//
// The well-known abandon×11 + about vector; deliberately unsuited for real use
// (anyone with the seed observes the wallet).
exports.TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
exports.TEST_MNEMONIC_WORDS = exports.TEST_MNEMONIC.split(' ');
// Most wallets accept a simple password; the Leather family (leather +
// cat21wallet, which is a Leather fork) runs a zxcvbn strength meter that
// rejects it, so it needs a strong one.
exports.SIMPLE_PASSWORD = 'TestPassword123!';
exports.LEATHER_FAMILY_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';
exports.PASSWORD_BY_WALLET = {
    xverse: exports.SIMPLE_PASSWORD,
    unisat: exports.SIMPLE_PASSWORD,
    wizz: exports.SIMPLE_PASSWORD,
    okx: exports.SIMPLE_PASSWORD,
    phantom: exports.SIMPLE_PASSWORD,
    alby: exports.SIMPLE_PASSWORD,
    leather: exports.LEATHER_FAMILY_PASSWORD,
    cat21wallet: exports.LEATHER_FAMILY_PASSWORD,
};
//# sourceMappingURL=wallet-test-vectors.js.map