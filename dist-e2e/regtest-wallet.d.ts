/**
 * The bitcoind wallet a regtest stack mines into and the helpers spend from.
 *
 * `regtest-bootstrap.sh` and `consumer-environment-bootstrap.sh` create it
 * under this name (`${REGTEST_WALLET:-ordpool-e2e}`), and the regtest helpers
 * pass it as `-rpcwallet`. A consumer that calls bitcoind itself (a backend
 * spec, a seeding script) reads the name here, so a stack bootstrapped under
 * another `REGTEST_WALLET` answers it instead of failing with bitcoind's `-18
 * Requested wallet does not exist or is not loaded`, which reads like a stack
 * that is down rather than a naming mismatch.
 */
/** The variable that names the wallet. */
export declare const REGTEST_WALLET_ENV = "REGTEST_WALLET";
/** The wallet name when `REGTEST_WALLET` is unset or empty, the bootstraps' default. */
export declare const DEFAULT_REGTEST_WALLET = "ordpool-e2e";
/** `REGTEST_WALLET` from `env`, else {@link DEFAULT_REGTEST_WALLET}; empty counts as unset, as in the bootstraps. */
export declare function regtestWallet(env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=regtest-wallet.d.ts.map