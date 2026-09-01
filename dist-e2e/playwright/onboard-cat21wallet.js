"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardCat21Wallet = onboardCat21Wallet;
const onboard_leather_1 = require("./onboard-leather");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
/**
 * Onboard Cat21 Wallet from the BIP-39 test seed to a signed-in dashboard.
 *
 * Cat21 Wallet is a Leather fork with the IDENTICAL onboarding flow (same
 * bundle testids), so this delegates to onboardLeather. Kept as its own named
 * export so consumers say the wallet they mean; shared by the e2e specs + the
 * local wallet-runner.
 */
async function onboardCat21Wallet(page, extensionId, opts = {}) {
    return (0, onboard_leather_1.onboardLeather)(page, extensionId, {
        mnemonic: opts.mnemonic,
        password: opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.cat21wallet,
    });
}
//# sourceMappingURL=onboard-cat21wallet.js.map