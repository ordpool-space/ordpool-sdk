// Small helpers shared across regtest E2E specs. Hits the local
// bitcoind RPC + electrs HTTP API directly — no Angular, no DI.
//
// Expects the regtest stack to be up via `e2e/regtest-bootstrap.sh`
// and `REGTEST_FUNDED_ADDR` / `REGTEST_FUNDED_WIF` set in env.

import { execSync } from 'node:child_process';

const ELECTRS_URL = process.env.REGTEST_ELECTRS_URL ?? 'http://localhost:3000';

export interface FundedAccount {
  address: string;
  wif: string;
}

export function getFundedAccount(): FundedAccount {
  const address = process.env.REGTEST_FUNDED_ADDR;
  const wif = process.env.REGTEST_FUNDED_WIF;
  if (!address || !wif) {
    throw new Error('REGTEST_FUNDED_ADDR and REGTEST_FUNDED_WIF must be set — run e2e/regtest-bootstrap.sh first');
  }
  return { address, wif };
}

/** Run a bitcoin-cli command inside the bitcoind container. */
export function rpc(...args: string[]): string {
  const cmd = ['docker', 'exec', 'ordpool-e2e-bitcoind',
    'bitcoin-cli', '-regtest', '-rpcuser=ordpool', '-rpcpassword=ordpool', ...args];
  return execSync(cmd.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' '), { encoding: 'utf8' }).trim();
}

/** Mine N blocks to a throwaway address. Returns the new tip height. */
export function mineBlocks(n: number): number {
  const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'legacy');
  rpc('-rpcwallet=ordpool-e2e', 'generatetoaddress', String(n), address);
  return Number(rpc('getblockcount'));
}

/** Wait until electrs has indexed up to (at least) the given height. */
export async function waitForElectrsSync(targetHeight: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tipText = await fetch(`${ELECTRS_URL}/blocks/tip/height`).then(r => r.text()).catch(() => '0');
    if (Number(tipText) >= targetHeight) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`electrs didn't reach height ${targetHeight} within ${timeoutMs}ms`);
}

export interface ElectrsUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

export async function getUtxos(address: string): Promise<ElectrsUtxo[]> {
  const res = await fetch(`${ELECTRS_URL}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`utxo fetch failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<ElectrsUtxo[]>;
}

export async function getTxHex(txid: string): Promise<string> {
  const res = await fetch(`${ELECTRS_URL}/tx/${txid}/hex`);
  if (!res.ok) throw new Error(`tx hex fetch failed: ${res.status} ${await res.text()}`);
  return (await res.text()).trim();
}

export async function postTx(hexPayload: string): Promise<string> {
  const res = await fetch(`${ELECTRS_URL}/tx`, {
    method: 'POST',
    body: hexPayload,
  });
  const body = (await res.text()).trim();
  if (!res.ok) throw new Error(`broadcast failed (${res.status}): ${body}`);
  return body;
}

export async function getTxStatus(txid: string): Promise<{ confirmed: boolean; block_height?: number }> {
  const res = await fetch(`${ELECTRS_URL}/tx/${txid}/status`);
  if (!res.ok) throw new Error(`tx status fetch failed: ${res.status}`);
  return res.json() as Promise<{ confirmed: boolean; block_height?: number }>;
}
