import type { TxnOutput } from './cat21.service.types.js';

/**
 * ordpool-electrs's answer to `GET /address/<a>/utxo`: the esplora UTXO list
 * `Cat21Service.getUtxos` reads (as `${mempoolApiUrl}/api/address/<a>/utxo`)
 * and `getUtxos` in `ordpool-sdk/e2e` reads from regtest.
 *
 * Source: ordpool-electrs at 439ef85b3841a53f1de4907ab8186ed604708077
 * (ORDPOOL_ELECTRS_SHA in e2e/build-pins.env, answering with `x-powered-by:
 * mempool-electrs 3.4.0-dev-439ef85`) over bitcoind 30.2.0 in the SDK's
 * e2e/docker-compose.regtest.yml stack. The bitcoind wallet sent 0.001 BTC to
 * the regtest bootstrap's funder address
 * (`electrsAddressUtxosFixtureAddress`), mined one block (height 102), then
 * sent 0.0005 BTC and left it in the mempool. Captured 2026-10-12T11:10:45Z
 * with `curl http://127.0.0.1:<electrs port>/address/<address>/utxo`.
 *
 * The two rows are the two shapes `status` takes: a confirmed coin carries
 * `block_height`, `block_hash` and `block_time`; an unconfirmed one carries
 * `confirmed: false` and nothing else.
 *
 * Each call returns fresh objects, so a spec may change what it got. A spec
 * that needs other coins says so at the call site, with the captured row as
 * the base:
 *
 *     electrsConfirmedUtxoFixture({ txid: 'ab'.repeat(32), value: 30_000 })
 */
export function electrsAddressUtxosFixture(): TxnOutput[] {
  return [electrsConfirmedUtxoFixture(), electrsUnconfirmedUtxoFixture()];
}

/** The address `electrsAddressUtxosFixture` was captured for: the funder of `e2e/regtest-bootstrap.sh`. */
export const electrsAddressUtxosFixtureAddress = 'bcrt1qw5pw5evmamu6dm5qze7a8yg07wmamvzpq3huc3';

/** The confirmed row of `electrsAddressUtxosFixture`, with `overrides` on top. */
export function electrsConfirmedUtxoFixture(overrides: Partial<TxnOutput> = {}): TxnOutput {
  return {
    txid: '481f417f40ab5c08503c14bf5b67e8a769e13097608c0b6076c44ca96f14330b',
    vout: 1,
    status: {
      confirmed: true,
      block_height: 102,
      block_hash: '6c50b3888a5e8ff34428b719db189140dfda1f43a5f2e1cf1198b7215b5131a7',
      block_time: 1791803461,
    },
    value: 100000,
    ...overrides,
  };
}

/** The unconfirmed row of `electrsAddressUtxosFixture`, with `overrides` on top. */
export function electrsUnconfirmedUtxoFixture(overrides: Partial<TxnOutput> = {}): TxnOutput {
  return {
    txid: 'be5aa699225b6695b392ec7fc7b55ee73512de73efd549d8dfe4f02192348f47',
    vout: 1,
    status: {
      confirmed: false,
    },
    value: 50000,
    ...overrides,
  };
}
