"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedAlbyAccount = seedAlbyAccount;
const wallet_test_vectors_1 = require("./wallet-test-vectors");
/**
 * Seed an Alby account from the BIP-39 test seed — PROGRAMMATICALLY via Alby's
 * service-worker message bus (setPassword → addAccount → setMnemonic), NOT a UI
 * onboard: Alby has no restore-from-seed onboarding UI, and its popup confirm()
 * never resolves headless. Envelope shape per Alby's common/lib/msg.ts. Returns
 * the created accountId. Shared by the e2e specs + the local wallet-runner.
 */
async function seedAlbyAccount(page, opts = {}) {
    const password = opts.password ?? wallet_test_vectors_1.PASSWORD_BY_WALLET.alby;
    const mnemonic = opts.mnemonic ?? wallet_test_vectors_1.TEST_MNEMONIC;
    const bitcoinNetwork = opts.bitcoinNetwork ?? 'regtest';
    const result = await page.evaluate(async ({ password, mnemonic, bitcoinNetwork }) => {
        const c = globalThis.chrome;
        const send = (action, args) => c.runtime.sendMessage({ application: 'LBE', prompt: true, action, args, origin: { internal: true } });
        const setPwResp = await send('setPassword', { password });
        const addAccResp = await send('addAccount', {
            name: 'ordpool-e2e',
            connector: 'lndhub',
            config: { url: 'https://example.invalid', login: 'x', password: 'x' },
            bitcoinNetwork,
        });
        const accountId = addAccResp?.data?.accountId;
        const setMnemoResp = accountId ? await send('setMnemonic', { id: accountId, mnemonic }) : null;
        return { setPwResp, addAccResp, accountId, setMnemoResp };
    }, { password, mnemonic, bitcoinNetwork });
    if (!result.accountId) {
        throw new Error(`Alby addAccount failed: ${JSON.stringify(result.addAccResp)}`);
    }
    return result.accountId;
}
//# sourceMappingURL=onboard-alby.js.map