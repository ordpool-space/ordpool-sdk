// Small helpers shared across regtest E2E specs. Hits the local
// bitcoind RPC + electrs HTTP API directly — no Angular, no DI.
//
// Expects the regtest stack to be up via `e2e/regtest-bootstrap.sh`
// and `REGTEST_FUNDED_ADDR` / `REGTEST_FUNDED_WIF` set in env.

import { execFileSync } from 'node:child_process';

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
/**
 * Pipe a `bitcoin-cli` command into the regtest container. Args go
 * through execFileSync (no shell), so JSON payloads with braces and
 * colons don't need extra escaping.
 */
export function rpc(...args: string[]): string {
  return execFileSync(
    'docker',
    ['exec', 'ordpool-e2e-bitcoind', 'bitcoin-cli',
     '-regtest', '-rpcuser=ordpool', '-rpcpassword=ordpool', ...args],
    { encoding: 'utf8' },
  ).trim();
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

/**
 * Wait for at least one UTXO to appear at `address` worth exactly
 * `expectedSats`. `waitForElectrsSync` only guarantees the block
 * tip is at the target height — electrs still needs additional
 * time to index that block's transactions into per-address UTXO
 * sets. The xverse / wizz / okx mint specs all hit this race
 * intermittently before this helper landed.
 */
export async function waitForUtxoAt(
  address: string,
  expectedSats: number,
  timeoutMs = 15_000,
): Promise<ElectrsUtxo> {
  const deadline = Date.now() + timeoutMs;
  let lastUtxos: ElectrsUtxo[] = [];
  while (Date.now() < deadline) {
    lastUtxos = await getUtxos(address);
    const hit = lastUtxos.find(u => u.value === expectedSats);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`UTXO of ${expectedSats} sats at ${address} didn't appear within ${timeoutMs}ms; got ${JSON.stringify(lastUtxos)}`);
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

export async function getTxStatus(txid: string): Promise<{ confirmed: boolean; block_height?: number; block_hash?: string }> {
  const res = await fetch(`${ELECTRS_URL}/tx/${txid}/status`);
  if (!res.ok) throw new Error(`tx status fetch failed: ${res.status}`);
  return res.json() as Promise<{ confirmed: boolean; block_height?: number; block_hash?: string }>;
}

/**
 * Full Esplora-format transaction record. Includes the fields the
 * `ordpool-parser` Cat21ParserService consumes: `locktime`, `weight`,
 * `fee`, and `status.block_hash`.
 */
export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  vin: unknown[];
  vout: unknown[];
  size: number;
  weight: number;
  fee: number;
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

export async function getTx(txid: string): Promise<EsploraTx> {
  const res = await fetch(`${ELECTRS_URL}/tx/${txid}`);
  if (!res.ok) throw new Error(`tx fetch failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<EsploraTx>;
}


interface EsploraVin {
  witness?: string[];
  scriptsig?: string;
  prevout?: { scriptpubkey_type?: string };
  is_coinbase?: boolean;
}

/**
 * Throws unless every signed input in `tx` commits to all outputs
 * under SIGHASH_ALL semantics. Used by every cat21 mint roundtrip
 * spec — a SIGHASH_NONE / SINGLE / ANYONECANPAY signature on the
 * mint input would let a relay-or-miner-side counterparty swap the
 * outputs (and steal the cat sat) while keeping the lockTime=21
 * commitment intact.
 *
 * Encoding per BIP-341 / BIP-143 / Bitcoin legacy:
 *  - Taproot key-path (witness item 0 is the Schnorr sig):
 *      64 bytes → SIGHASH_DEFAULT (encodes identically to
 *                 SIGHASH_ALL on the wire — both commit to all
 *                 outputs; the explicit-default form is shorter)
 *      65 bytes → last byte is the sighash flag; must be 0x01
 *  - ECDSA SegWit (P2WPKH, witness item 0 is DER sig + sighash):
 *      last byte of the sig must be 0x01
 *  - Legacy P2PKH (scriptsig starts with a push of DER sig):
 *      last byte of the pushed sig must be 0x01
 */
export function assertAllInputsSighashAll(tx: EsploraTx): void {
  for (let i = 0; i < tx.vin.length; i++) {
    const input = tx.vin[i] as EsploraVin;
    if (input.is_coinbase) continue;
    const witness = input.witness ?? [];
    if (witness.length > 0) {
      const sigHex = witness[0];
      const isTaproot = input.prevout?.scriptpubkey_type === 'v1_p2tr';
      if (isTaproot) {
        if (sigHex.length === 128) continue;
        if (sigHex.length === 130) {
          const flag = sigHex.slice(-2);
          if (flag === '01') continue;
          throw new Error(`Input ${i}: Taproot sighash flag 0x${flag} (expected 0x01 = SIGHASH_ALL)`);
        }
        throw new Error(`Input ${i}: Taproot sig wrong length ${sigHex.length / 2} bytes (expected 64 or 65)`);
      }
      const flag = sigHex.slice(-2);
      if (flag !== '01') throw new Error(`Input ${i}: SegWit sighash flag 0x${flag} (expected 0x01 = SIGHASH_ALL)`);
    } else if (input.scriptsig) {
      const ss = input.scriptsig;
      const pushLen = parseInt(ss.slice(0, 2), 16);
      const sigEnd = (1 + pushLen) * 2;
      const sigHex = ss.slice(2, sigEnd);
      const flag = sigHex.slice(-2);
      if (flag !== '01') throw new Error(`Input ${i}: Legacy sighash flag 0x${flag} (expected 0x01 = SIGHASH_ALL)`);
    }
  }
}
