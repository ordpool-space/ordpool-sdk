"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNISAT_WALLET_API = void 0;
exports.decodeUnisatPsbt = decodeUnisatPsbt;
exports.unisatOfflineAnswer = unisatOfflineAnswer;
exports.installUnisatOfflineRoutes = installUnisatOfflineRoutes;
const btc_signer_1 = require("@scure/btc-signer");
const base_1 = require("@scure/base");
/**
 * UniSat's wallet API on every network it knows: `wallet-api.unisat.space` and
 * `wallet-api.unisat.io` for mainnet (the extension's `endpoints` list, tried
 * in that order), plus the `-testnet`, `-signet`, `-fractal` variants it
 * switches to with the network.
 */
exports.UNISAT_WALLET_API = /^https:\/\/wallet-api(-[a-z-]+)?\.unisat\.(space|io)\//;
/** UniSat's per-address asset summary for an address holding nothing. */
const ZERO_ASSET = {
    totalSatoshis: 0, btcSatoshis: 0, assetSatoshis: 0, inscriptionCount: 0,
    atomicalsCount: 0, brc20Count: 0, brc20Count5Byte: 0, brc20Count6Byte: 0,
    arc20Count: 0, runesCount: 0,
};
/**
 * Response bodies captured from wallet-api.unisat.space and
 * wallet-api.unisat.io on 2026-10-10, while the extension (v1.7.15) ran the
 * unisat-* specs with the test seed. Every account is empty, so these are the
 * server's own answers for an empty wallet; the price and the fee summary are
 * that day's values. One departure: the server's notification list carries
 * UniSat's announcements, answered here as the empty list in the same shape.
 */
const CAPTURED = {
    '/v5/default/config': { version: '1.7.19', statusMessage: '', chainTip: '', endpoint: '', restrictRegion: false, disableUtxoTools: false },
    '/v5/default/price': { btc: 82968.50954320238, fb: 0.3869041631877719 },
    '/v5/default/fee-summary': { list: [
            { title: 'Slow', desc: 'About 1 hours', feeRate: 1 },
            { title: 'Avg', desc: 'About 30 minutes', feeRate: 1 },
            { title: 'Fast', desc: 'About 10 minutes', feeRate: 1 },
        ] },
    '/v5/default/check-website': { isScammer: false, warning: '', allowQuickMultiSign: false },
    '/v5/address/summary': ZERO_ASSET,
    '/v5/address/balance2': { availableBalance: 0, unavailableBalance: 0, totalBalance: 0 },
    '/v5/address/inscriptions': { list: [], total: 0 },
    '/v5/announcement/list': { list: [], total: 0 },
    '/v5/notification/list': { list: [], total: 0 },
    '/v5/phishing-detect/hotlist': {
        allowlist: ['unisat-wallet.github.io', 'ai-nexus402.com', 'unisat-web3-demo-t0.degen.earth', 'www.yzailabs.com'],
        blacklist: ['unisat.repaironchain.com'],
    },
};
/** UniSat's envelope: `{ code: 0, msg: 'ok', data }` on success. */
function ok(data) {
    return {
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: JSON.stringify({ code: 0, msg: 'ok', data }),
    };
}
/** No assets on any coin: regtest carries none UniSat's indexers know of. */
const UTXO_STATUS_UNINDEXED = {
    utxoFound: false, atomicalsChecked: false, isConfirmed: false, inscriptionDoubleChecked: false,
    runesChecked: false, indexerChecked: false, unlocked: false,
};
/**
 * `POST /v5/tx/decode2`, answered from the PSBT itself.
 *
 * With this request unanswered the sign popup never shows its Sign button, so
 * it cannot be aborted like an unknown endpoint. Field by field it is what the server returned
 * for every regtest PSBT the unisat-* specs sent it: the prevout and output
 * scripts encoded as MAINNET addresses (the wallet is mainnet), no assets, no
 * risks, `onchain: false` and every `utxoStatus` flag false because the coins
 * exist only on regtest, `sighashType` only on inputs whose PSBT field sets it,
 * `features.rbf` when an input signals BIP-125 (sequence below 0xfffffffe).
 * `isCompleted: true` and `recommendedFeeRate: 1` are the constants of every
 * captured answer. `feeRate` is display text: the fee over the size of the
 * unsigned transaction (no witness yet), so it reads above the final rate.
 * `shouldWarnFeeRate` is false, which keeps the popup's default styling.
 */
function decodeUnisatPsbt(psbtHex) {
    const tx = btc_signer_1.Transaction.fromPSBT(base_1.hex.decode(psbtHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
    const address = (script) => {
        try {
            return (0, btc_signer_1.Address)(btc_signer_1.NETWORK).encode(btc_signer_1.OutScript.decode(script));
        }
        catch {
            return '';
        }
    };
    let totalIn = 0n;
    let rbf = false;
    const inputInfos = Array.from({ length: tx.inputsLength }, (_, i) => {
        const input = tx.getInput(i);
        const vout = input.index ?? 0;
        const prevout = input.witnessUtxo ?? input.nonWitnessUtxo?.outputs[vout];
        if (!input.txid || !prevout?.script || prevout.amount === undefined) {
            throw new Error(`decode2: input ${i} carries no prevout, which every PSBT the SDK builds does`);
        }
        totalIn += prevout.amount;
        if ((input.sequence ?? 0xffffffff) < 0xfffffffe)
            rbf = true;
        return {
            txid: base_1.hex.encode(input.txid),
            vout,
            address: address(prevout.script),
            value: Number(prevout.amount),
            inscriptions: [], atomicals: [], alkanes: [], runes: [],
            ...(input.sighashType === undefined ? {} : { sighashType: input.sighashType }),
            onchain: false,
            utxoStatus: UTXO_STATUS_UNINDEXED,
            brc20Count: 0,
        };
    });
    let totalOut = 0n;
    const outputInfos = Array.from({ length: tx.outputsLength }, (_, i) => {
        const output = tx.getOutput(i);
        const script = output.script ?? new Uint8Array();
        totalOut += output.amount ?? 0n;
        return {
            address: address(script),
            value: Number(output.amount ?? 0n),
            inscriptions: [], atomicals: [], runes: [], alkanes: [],
            isOpReturn: script[0] === 0x6a,
        };
    });
    const fee = Number(totalIn - totalOut);
    return {
        inputInfos,
        outputInfos,
        feeRate: `≈${(fee / tx.unsignedTx.length).toFixed(1)}`,
        fee,
        isCompleted: true,
        risks: [],
        features: { rbf },
        inscriptions: {},
        recommendedFeeRate: 1,
        shouldWarnFeeRate: false,
    };
}
/**
 * The answer for one wallet-API request, or `null` for an endpoint with no
 * captured answer.
 */
function unisatOfflineAnswer(url, postData = null) {
    const path = url.pathname;
    if (path === '/v5/address/multi-assets') {
        // One entry per queried address: the wallet indexes the answer by position.
        const addresses = (url.searchParams.get('addresses') ?? '').split(',').filter(Boolean);
        return addresses.map(() => ZERO_ASSET);
    }
    if (path === '/v5/version/detail') {
        const version = url.searchParams.get('version') ?? '';
        return { version, title: `A new version v${version} is available`, notice: '', changelogs: [] };
    }
    if (path === '/v5/tx/decode2') {
        const { psbtHex } = JSON.parse(postData ?? '{}');
        return psbtHex ? decodeUnisatPsbt(psbtHex) : null;
    }
    return path in CAPTURED ? CAPTURED[path] : null;
}
/**
 * Keep UniSat's vendor backend out of the test: every request to its wallet
 * API is answered locally, the way a working server answers an empty wallet.
 *
 * The extension gates its UI on that API. The connect approval renders a
 * spinner until `POST /v5/default/check-website` for the requesting origin
 * resolves, and its `.then()` has no rejection branch, so when the API hangs,
 * fails or answers with an error page the popup stays a spinner and never
 * mounts its Connect button. The extension's own client gives each attempt
 * 30 s and retries three times. The sign popup waits on `tx/decode2` the same
 * way. With the API live, every spec that connects or signs passes or fails
 * on the vendor's availability, not on ours.
 *
 * An endpoint with no captured answer is aborted, so a new dependency fails at
 * once and is listed by `recordWalletBackendRequests` rather than waiting on a
 * live server.
 *
 * Install right after the context launches, before onboarding. The requests
 * the service worker sends while the extension starts, before this is
 * installed, still reach the network; the whole unisat lane passes with the
 * API unreachable, so none of them gates a popup.
 */
async function installUnisatOfflineRoutes(context) {
    await context.route(exports.UNISAT_WALLET_API, (route) => {
        const request = route.request();
        const answer = unisatOfflineAnswer(new URL(request.url()), request.postData());
        return answer === null ? route.abort('failed') : route.fulfill(ok(answer));
    });
}
//# sourceMappingURL=unisat-offline-routes.js.map