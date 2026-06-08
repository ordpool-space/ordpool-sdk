// Consumer-environment factory: a typed read of the JSON descriptor
// produced by `e2e/consumer-environment-bootstrap.sh`, plus a couple
// of convenience helpers that wrap the same bring-up so Playwright
// specs can spin up the full Bitcoin + DB infrastructure from inside
// a beforeAll hook instead of relying on the CI workflow having
// already done it.
//
// Both consumer E2E workflows (ordpool/.github/workflows/e2e-regtest-
// mint.yml and cat21-indexer/.github/workflows/e2e-regtest-mint.yml)
// import from this file so the harness shape stays the same across
// repos.

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Full descriptor of a running consumer-environment stack. Mirrors
 * the JSON shape produced by `consumer-environment-bootstrap.sh`.
 *
 * When you add a field here, mirror it in the bootstrap script too.
 */
export interface ConsumerEnvironmentUrls {
  bitcoind: {
    rpcUrl: string;
    rpcUser: string;
    rpcPassword: string;
    zmqRawBlock: string;
    zmqRawTx: string;
  };
  electrs: {
    httpUrl: string;
    electrumRpcUrl: string;
  };
  mariadb: {
    host: string;
    port: number;
    rootPassword: string;
    ordpool: { database: string; user: string; password: string };
    cat21:   { database: string; user: string; password: string };
  };
  redis: { url: string } | null;
  fundedAddress: string;
  fundedWif: string;
}

export interface SetupConsumerEnvironmentOptions {
  /** Path to the SDK's `e2e/` directory. Defaults to walking up from this file. */
  sdkE2eDir?: string;
  /**
   * Extra docker-compose files to layer on top of the SDK's base. Use
   * absolute paths so docker can resolve them regardless of cwd. The
   * consumer's own backend services live here.
   */
  extraComposeFiles?: string[];
  /** Spin up the redis container alongside mariadb. Off by default. */
  withRedis?: boolean;
  /** Where to read/write the JSON env descriptor. Defaults to a tmp path. */
  envJsonPath?: string;
}

/**
 * Bring the consumer-environment stack up and return its URL map.
 * Idempotent — if the containers are already running it returns the
 * current descriptor without re-mining 101 blocks.
 *
 * For most CI workflows the bootstrap script is called directly from
 * the workflow YAML (cheaper, no Node startup). This wrapper exists
 * for Playwright specs that want to manage the environment from
 * inside `globalSetup` instead of from the workflow.
 */
export function setupConsumerEnvironment(
  options: SetupConsumerEnvironmentOptions = {},
): ConsumerEnvironmentUrls {
  const sdkE2eDir = options.sdkE2eDir ?? path.resolve(__dirname, '..');
  const bootstrap = path.join(sdkE2eDir, 'consumer-environment-bootstrap.sh');

  const args: string[] = [];
  if (options.withRedis) args.push('--with-redis');
  for (const extra of options.extraComposeFiles ?? []) {
    args.push('--extra-file', extra);
  }

  const result = spawnSync(bootstrap, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `consumer-environment-bootstrap.sh exited ${result.status}\n` +
      `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }

  const env = JSON.parse(result.stdout) as ConsumerEnvironmentUrls;

  if (options.envJsonPath) {
    fs.writeFileSync(options.envJsonPath, result.stdout);
  }

  return env;
}

/**
 * Read a previously written env JSON dump. Used when the CI workflow
 * calls the bootstrap script directly and pipes the JSON to a file
 * the spec then reads in `beforeAll`.
 */
export function readConsumerEnvironment(jsonPath: string): ConsumerEnvironmentUrls {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  return JSON.parse(raw) as ConsumerEnvironmentUrls;
}

/**
 * Tear the stack down. Optional — CI runners are ephemeral, so the
 * "always teardown" step in the workflow YAML is usually enough.
 */
export function teardownConsumerEnvironment(options: { sdkE2eDir?: string } = {}): void {
  const sdkE2eDir = options.sdkE2eDir ?? path.resolve(__dirname, '..');
  const composeFile = path.join(sdkE2eDir, 'docker-compose.consumer-environment.yml');
  execSync(`docker compose -f "${composeFile}" down -v`, { stdio: 'inherit' });
}

/**
 * Mine N regtest blocks. Common Playwright spec step after broadcast
 * — confirms the mint and lets the pending → confirmed transition
 * happen on the consumer's UI.
 */
export function mineBlocks(env: ConsumerEnvironmentUrls, count = 1, toAddress?: string): void {
  const addr = toAddress ?? env.fundedAddress;
  execSync(
    `docker exec ordpool-e2e-consumer-bitcoind ` +
    `bitcoin-cli -regtest -rpcuser=${env.bitcoind.rpcUser} -rpcpassword=${env.bitcoind.rpcPassword} ` +
    `-rpcwallet=ordpool-e2e generatetoaddress ${count} ${addr}`,
    { stdio: 'inherit' },
  );
}
