"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardableWallets = exports.walletOnboarders = void 0;
const onboard_xverse_1 = require("./onboard-xverse");
const onboard_unisat_1 = require("./onboard-unisat");
const onboard_leather_1 = require("./onboard-leather");
const onboard_wizz_1 = require("./onboard-wizz");
const onboard_okx_1 = require("./onboard-okx");
const onboard_phantom_1 = require("./onboard-phantom");
const onboard_alby_1 = require("./onboard-alby");
const onboard_cat21wallet_1 = require("./onboard-cat21wallet");
const wallet_test_vectors_1 = require("./wallet-test-vectors");
// ONE place that answers "how do I onboard wallet X" — consumed by the e2e
// specs AND the local regtest wallet-runner. The `onboard-<wallet>.ts` helpers
// take either (page) or (context); this registry normalizes them all to
// (context, extensionId) so a consumer never needs wallet-specific code.
const onPage = (fn) => async (context, extensionId) => {
    await fn(await context.newPage(), extensionId);
};
exports.walletOnboarders = {
    xverse: {
        // Onboard AND switch to regtest + point its electrs at ours — a regtest-
        // ready wallet in one call (global-setup layers a seed-dir cache on top).
        onboard: async (ctx, id) => {
            await (0, onboard_xverse_1.onboardXverse)(ctx, id);
            await (0, onboard_xverse_1.primeAndSwitchToRegtest)(ctx, id);
            await (0, onboard_xverse_1.overrideRegtestElectrsUrl)(ctx, id, process.env.XVERSE_REGTEST_ELECTRS_URL ?? 'http://localhost:3000');
        },
        password: wallet_test_vectors_1.PASSWORD_BY_WALLET.xverse,
    },
    unisat: { onboard: onPage((p, id) => (0, onboard_unisat_1.onboardUnisat)(p, id)), password: wallet_test_vectors_1.PASSWORD_BY_WALLET.unisat },
    leather: { onboard: onPage((p, id) => (0, onboard_leather_1.onboardLeather)(p, id)), password: wallet_test_vectors_1.PASSWORD_BY_WALLET.leather },
    wizz: { onboard: onPage((p, id) => (0, onboard_wizz_1.onboardWizz)(p, id)), password: wallet_test_vectors_1.PASSWORD_BY_WALLET.wizz },
    okx: { onboard: onPage((p, id) => (0, onboard_okx_1.onboardOkx)(p, id)), password: wallet_test_vectors_1.PASSWORD_BY_WALLET.okx },
    cat21wallet: { onboard: onPage((p, id) => (0, onboard_cat21wallet_1.onboardCat21Wallet)(p, id)), password: wallet_test_vectors_1.PASSWORD_BY_WALLET.cat21wallet },
    phantom: {
        onboard: onPage((p, id) => (0, onboard_phantom_1.onboardPhantom)(p, id)),
        password: wallet_test_vectors_1.PASSWORD_BY_WALLET.phantom,
        caveat: 'connect blocked — v26 desktop ships btc.js dormant: onboards, but cannot connect or sign',
    },
    alby: {
        // seedAlbyAccount talks to Alby's service worker via chrome.runtime.sendMessage,
        // which only exists on a chrome-extension:// origin — so land on options.html
        // before seeding (mirrors the real alby-*.spec.ts setup); a bare about:blank page
        // has no chrome.runtime and the seed throws.
        onboard: onPage(async (p, id) => {
            await p.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded' });
            return (0, onboard_alby_1.seedAlbyAccount)(p);
        }),
        password: wallet_test_vectors_1.PASSWORD_BY_WALLET.alby,
        caveat: 'sign blocked headless — its popup confirm() never resolves (seeded programmatically via the SW)',
    },
};
/** Wallet names with a reusable onboarder (every wallet the E2E supports). */
exports.onboardableWallets = Object.keys(exports.walletOnboarders);
//# sourceMappingURL=wallet-onboarders.js.map