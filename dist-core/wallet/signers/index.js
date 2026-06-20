"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xverseSigner = exports.wizzSigner = exports.unisatSigner = exports.psbtExportSigner = exports.phantomSigner = exports.oylSigner = exports.okxSigner = exports.leatherSigner = exports.cat21walletSigner = exports.binanceSigner = exports.albySigner = exports.walletSigners = void 0;
exports.findSigner = findSigner;
exports.findSignerOrThrow = findSignerOrThrow;
const alby_signer_1 = require("./alby.signer");
const binance_signer_1 = require("./binance.signer");
const cat21wallet_signer_1 = require("./cat21wallet.signer");
const leather_signer_1 = require("./leather.signer");
const okx_signer_1 = require("./okx.signer");
const oyl_signer_1 = require("./oyl.signer");
const phantom_signer_1 = require("./phantom.signer");
const psbt_export_signer_1 = require("./psbt-export.signer");
const unisat_signer_1 = require("./unisat.signer");
const wizz_signer_1 = require("./wizz.signer");
const xverse_signer_1 = require("./xverse.signer");
/**
 * Sign-side wallet roster. Per CLAUDE.md "Ship every signer we
 * have code for": every WalletSigner file in this directory is
 * registered here. No second-gate filtering on top of
 * detect-by-signature.
 *
 * The wallet picker surfaces a wallet IF `window.<wallet>` is
 * present at runtime. If a user reaches the signer call, detect
 * already said yes. The registry's only job is to provide the
 * call shape — Pipeline B evidence about whether a particular
 * shipped binary honours that shape lives in skip-comments on
 * the e2e specs and docstrings on the signer files, NOT here.
 *
 * Known runtime caveats (see each signer file for details):
 *   - phantom: current desktop binary ships btc.js dormant
 *     (v26.x), so detect returns false on desktop and the
 *     signer isn't reached. Phantom mobile in-app browser is
 *     documented to expose `window.phantom.bitcoin`; signer is
 *     ready for that case automatically.
 *   - alby: signPsbt delegates to whatever on-chain backend the
 *     user wired (Alby Hub / Mutiny / …). Users without one
 *     get a runtime error from the wallet.
 *
 * `psbtExportSigner` is the universal watch-only signer (Sparrow,
 * Electrum, Coldcard, Ledger, Trezor, …). It covers any wallet
 * that speaks PSBT but doesn't inject JS into the browser.
 *
 * Read roster lives in `connectors/` and uses the same one-rule
 * gating (detect-by-signature).
 */
exports.walletSigners = [
    cat21wallet_signer_1.cat21walletSigner,
    xverse_signer_1.xverseSigner,
    leather_signer_1.leatherSigner,
    unisat_signer_1.unisatSigner,
    okx_signer_1.okxSigner,
    oyl_signer_1.oylSigner,
    wizz_signer_1.wizzSigner,
    phantom_signer_1.phantomSigner,
    alby_signer_1.albySigner,
    binance_signer_1.binanceSigner,
    psbt_export_signer_1.psbtExportSigner,
];
/**
 * Returns the signer for the given wallet type, or `undefined` if
 * no matching signer is registered. Callers that need a hard
 * guarantee should look up via {@link findSignerOrThrow}.
 */
function findSigner(type) {
    return exports.walletSigners.find(s => s.providerId === type);
}
function findSignerOrThrow(type) {
    const signer = findSigner(type);
    if (!signer) {
        throw new Error(`No signer registered for wallet type: ${type}`);
    }
    return signer;
}
var alby_signer_2 = require("./alby.signer");
Object.defineProperty(exports, "albySigner", { enumerable: true, get: function () { return alby_signer_2.albySigner; } });
var binance_signer_2 = require("./binance.signer");
Object.defineProperty(exports, "binanceSigner", { enumerable: true, get: function () { return binance_signer_2.binanceSigner; } });
var cat21wallet_signer_2 = require("./cat21wallet.signer");
Object.defineProperty(exports, "cat21walletSigner", { enumerable: true, get: function () { return cat21wallet_signer_2.cat21walletSigner; } });
var leather_signer_2 = require("./leather.signer");
Object.defineProperty(exports, "leatherSigner", { enumerable: true, get: function () { return leather_signer_2.leatherSigner; } });
var okx_signer_2 = require("./okx.signer");
Object.defineProperty(exports, "okxSigner", { enumerable: true, get: function () { return okx_signer_2.okxSigner; } });
var oyl_signer_2 = require("./oyl.signer");
Object.defineProperty(exports, "oylSigner", { enumerable: true, get: function () { return oyl_signer_2.oylSigner; } });
var phantom_signer_2 = require("./phantom.signer");
Object.defineProperty(exports, "phantomSigner", { enumerable: true, get: function () { return phantom_signer_2.phantomSigner; } });
var psbt_export_signer_2 = require("./psbt-export.signer");
Object.defineProperty(exports, "psbtExportSigner", { enumerable: true, get: function () { return psbt_export_signer_2.psbtExportSigner; } });
var unisat_signer_2 = require("./unisat.signer");
Object.defineProperty(exports, "unisatSigner", { enumerable: true, get: function () { return unisat_signer_2.unisatSigner; } });
var wizz_signer_2 = require("./wizz.signer");
Object.defineProperty(exports, "wizzSigner", { enumerable: true, get: function () { return wizz_signer_2.wizzSigner; } });
var xverse_signer_2 = require("./xverse.signer");
Object.defineProperty(exports, "xverseSigner", { enumerable: true, get: function () { return xverse_signer_2.xverseSigner; } });
//# sourceMappingURL=index.js.map