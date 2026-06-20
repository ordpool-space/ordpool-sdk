import * as btc from '@scure/btc-signer';
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
declare const BitcoinNetworkType: {
    readonly Mainnet: "Mainnet";
    readonly Testnet: "Testnet";
    readonly Testnet4: "Testnet4";
    readonly Signet: "Signet";
    readonly Regtest: "Regtest";
};
type BitcoinNetworkType = (typeof BitcoinNetworkType)[keyof typeof BitcoinNetworkType];
/**
 * Bitcoin network the SDK is operating on. Matches the bitcoinjs /
 * noble convention: explicit enum, not a boolean, `isMainnet` flattens
 * four distinct testnets into one, which has bitten us before.
 *
 * Today only `Mainnet` is exercised in production (ordpool no longer
 * routes a testnet UI). The other variants exist so a future Node
 * script or CLI can target them without re-shaping the API.
 */
export declare enum Network {
    Mainnet = "mainnet",
    Testnet3 = "testnet3",
    Testnet4 = "testnet4",
    Signet = "signet",
    Regtest = "regtest"
}
/**
 * Convert to @scure/btc-signer's network object. Mainnet -> NETWORK,
 * Regtest -> a hand-rolled `bcrt`-prefixed network object, all
 * remaining testnet variants -> TEST_NETWORK (scure doesn't
 * distinguish testnet3 / testnet4 / signet at this layer).
 */
export declare function toScureNetwork(network: Network): typeof btc.NETWORK;
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
export declare function toBitcoinNetworkType(network: Network): BitcoinNetworkType;
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
export declare function toLeatherNetworkString(network: Network): 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet' | 'regtest';
export {};
//# sourceMappingURL=network.d.ts.map