"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Network = void 0;
exports.toScureNetwork = toScureNetwork;
exports.toBitcoinNetworkType = toBitcoinNetworkType;
exports.toLeatherNetworkString = toLeatherNetworkString;
const btc = __importStar(require("@scure/btc-signer"));
/**
 * Sats-connect's `BitcoinNetworkType` enum, redeclared locally.
 *
 * Why not import from `sats-connect` directly: sats-connect's index
 * pulls axios (and therefore `process/browser`) into anything that
 * imports `ordpool-sdk/core`. The wallet's MV3 background bundle
 * can't resolve `process/browser` from inside the SDK's
 * `node_modules/axios/lib`, so the whole core entry stops importing.
 * The enum values are wire-protocol strings, identical to what
 * sats-connect declares (`'Mainnet' | 'Testnet' | 'Testnet4' |
 * 'Signet' | 'Regtest'`), so a local copy passes Xverse's mode-
 * string check at runtime without any sats-connect code being
 * loaded.
 */
const BitcoinNetworkType = {
    Mainnet: 'Mainnet',
    Testnet: 'Testnet',
    Testnet4: 'Testnet4',
    Signet: 'Signet',
    Regtest: 'Regtest',
};
/**
 * Bitcoin network the SDK is operating on. Matches the bitcoinjs /
 * noble convention: explicit enum, not a boolean, `isMainnet` flattens
 * four distinct testnets into one, which has bitten us before.
 *
 * Today only `Mainnet` is exercised in production (ordpool no longer
 * routes a testnet UI). The other variants exist so a future Node
 * script or CLI can target them without re-shaping the API.
 */
var Network;
(function (Network) {
    Network["Mainnet"] = "mainnet";
    Network["Testnet3"] = "testnet3";
    Network["Testnet4"] = "testnet4";
    Network["Signet"] = "signet";
    Network["Regtest"] = "regtest";
})(Network || (exports.Network = Network = {}));
/**
 * Regtest uses the same key/script prefixes as testnet but a
 * different bech32 HRP (`bcrt` not `tb`). @scure/btc-signer doesn't
 * ship a regtest constant, we provide one so `Network.Regtest`
 * actually round-trips through the signer without yielding `tb1q…`
 * addresses that bitcoind in regtest mode then rejects.
 */
const REGTEST_NETWORK = {
    bech32: 'bcrt',
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef,
};
/**
 * Convert to @scure/btc-signer's network object. Mainnet -> NETWORK,
 * Regtest -> a hand-rolled `bcrt`-prefixed network object, all
 * remaining testnet variants -> TEST_NETWORK (scure doesn't
 * distinguish testnet3 / testnet4 / signet at this layer).
 */
function toScureNetwork(network) {
    if (network === Network.Mainnet)
        return btc.NETWORK;
    if (network === Network.Regtest)
        return REGTEST_NETWORK;
    return btc.TEST_NETWORK;
}
/**
 * Convert to sats-connect's BitcoinNetworkType. v4+ declares all
 * five variants natively (Mainnet, Testnet, Testnet4, Signet,
 * Regtest), so the v1-era `as BitcoinNetworkType` casts can go.
 *
 * Xverse's mismatch-check is string-equality between the request
 * `network.type` and the wallet's active chain `mode`; v4's enum
 * values match Xverse's mode strings exactly (one of the reasons
 * upgrading was worth doing).
 */
function toBitcoinNetworkType(network) {
    if (network === Network.Mainnet)
        return BitcoinNetworkType.Mainnet;
    if (network === Network.Testnet3)
        return BitcoinNetworkType.Testnet;
    if (network === Network.Testnet4)
        return BitcoinNetworkType.Testnet4;
    if (network === Network.Signet)
        return BitcoinNetworkType.Signet;
    if (network === Network.Regtest)
        return BitcoinNetworkType.Regtest;
    throw new Error(`Unsupported Bitcoin network: ${network}`);
}
/**
 * Leather wallet's `network` field accepts these strings.
 * Testnet variants flatten to 'testnet'.
 *
 * Regtest mapping nuance: upstream Leather labels its bcrt-HRP
 * network slot `devnet` (a Stacks-isms artifact inherited from
 * Hiro's stacks-devnet convention). CAT-21 wallet adds the
 * Bitcoin-standard `regtest` slot alongside it (see the wallet's
 * `WalletDefaultNetworkConfigurationIds.regtest` HACK marker), so
 * we return the standard term going forward. The wallet still
 * accepts `'devnet'` for back-compat with dapps written against
 * the upstream-Leather contract.
 */
function toLeatherNetworkString(network) {
    switch (network) {
        case Network.Mainnet: return 'mainnet';
        case Network.Signet: return 'signet';
        case Network.Regtest: return 'regtest';
        default: return 'testnet';
    }
}
//# sourceMappingURL=network.js.map