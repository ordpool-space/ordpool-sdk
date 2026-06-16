// Small helpers shared across regtest E2E specs. Hits the local
// bitcoind RPC + electrs HTTP API directly — no Angular, no DI.
//
// Expects the regtest stack to be up via `e2e/regtest-bootstrap.sh`
// and `REGTEST_FUNDED_ADDR` / `REGTEST_FUNDED_WIF` set in env.

import { execFileSync } from 'node:child_process';

const ELECTRS_URL = process.env.REGTEST_ELECTRS_URL ?? 'http://localhost:3000';
const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';

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

/**
 * Wait until electrs has CONFIRMED `txid` — i.e. the per-tx status
 * endpoint returns `confirmed: true` AND a non-empty `block_hash`.
 *
 * Why this exists separately from `waitForElectrsSync`:
 * `waitForElectrsSync` only checks the chain-tip height endpoint
 * (`/blocks/tip/height`). electrs serves that endpoint the moment
 * it sees the new block header, but the per-tx status (`/tx/:id/
 * status`) needs an extra pass to map the tx into its containing
 * block. That gap is hundreds of ms to a few seconds on a cold
 * runner. Without this helper a mint roundtrip's subsequent
 * `getTx(txid)` call intermittently returns `block_hash: undefined`
 * (iter 114 — `block_hash=undefined` race, observed flaking on
 * xverse-mint, leather-mint, and any other mint spec that
 * inspects the confirmation status).
 *
 * Polls every 200ms by default. Returns the EsploraTx once the
 * confirmation is observable; throws if the deadline is reached.
 */
export async function waitForTxConfirmed(
  txid: string,
  timeoutMs = 15_000,
): Promise<EsploraTx> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: EsploraTx | undefined;
  while (Date.now() < deadline) {
    const tx = await getTx(txid).catch(() => undefined);
    if (tx) {
      lastSeen = tx;
      if (tx.status.confirmed && tx.status.block_hash) return tx;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(
    `tx ${txid} not confirmed within ${timeoutMs}ms; ` +
    `last status: ${lastSeen ? JSON.stringify(lastSeen.status) : 'not-found'}`
  );
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
// ─── cat21-ord helpers ───────────────────────────────────────────────
//
// Used by the multi-step `cat21-flow-roundtrip` spec for two things:
//   1. Verifying the cat's current address after each step (the spec
//      asks ord which address owns inscription <minting_tx>i0).
//   2. Producing ord's reference buy-offer PSBT for byte-comparison
//      against the SDK's `buildCat21BuyOfferPsbt` output.
//
// ord serves HTML by default; every query here sends
// `Accept: application/json` to get structured output. ord recognises
// the inscription path by id (`<txid>i<index>`); for cat21 fake-
// inscriptions, the index is always 0.

/** Build a cat21 inscription id from its minting txid. */
export function catInscriptionId(mintTxid: string): string {
  return `${mintTxid}i0`;
}

/**
 * Poll ord's HTTP server until it answers `/status` with a 2xx — the
 * binary takes a moment to warm its index before binding. The compose
 * file has no healthcheck because the slim runtime image lacks wget/curl,
 * so the test bootstrap polls here.
 */
export async function waitForOrdReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(`${ORD_URL}/status`).then(r => r.ok).catch(() => false);
    if (ok) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`ord didn't respond on /status within ${timeoutMs}ms`);
}

/**
 * Block until ord has indexed up to (at least) `targetHeight`. ord's
 * indexer is one step behind electrs/bitcoind — it sees the new block
 * via ZMQ or polling and runs its CAT-21 filter on every tx. Without
 * this gate the cat-state assertions race the indexer.
 */
export async function waitForOrdSync(targetHeight: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetch(`${ORD_URL}/status`, {
      headers: { Accept: 'application/json' },
    }).then(r => r.ok ? r.json() : null).catch(() => null) as { height?: number } | null;
    if (status && typeof status.height === 'number' && status.height >= targetHeight) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`ord didn't reach height ${targetHeight} within ${timeoutMs}ms`);
}

export interface OrdInscription {
  /** Address currently holding the inscription (the "owner"). */
  address: string;
  /** UTXO carrying the inscription, `<txid>:<vout>` form. */
  output: string;
  /** Sat number on which the inscription sits. */
  sat?: number | null;
  /** Sats locked in the inscription's UTXO. */
  value: number;
  /** ord's inscription number (= cat number under --index-cat21). */
  number: number;
  /** The inscription id, `<txid>i<index>`. */
  id: string;
}

/**
 * Fetch a cat's inscription record from ord. Returns the owner address,
 * current UTXO, and other ord-side state. Throws on any non-2xx — the
 * caller passes through after asserting on shape.
 */
export async function getOrdInscription(inscriptionId: string): Promise<OrdInscription> {
  const res = await fetch(`${ORD_URL}/inscription/${inscriptionId}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`ord /inscription/${inscriptionId} returned ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<OrdInscription>;
}

/**
 * Wait until ord reports the cat at `inscriptionId` is owned by
 * `expectedAddress`. Polls every 300ms; throws on timeout with the
 * last-observed owner.
 *
 * Use this after each broadcast + confirm step in the multi-step spec
 * to assert the cat actually moved where the SDK said it would.
 */
export async function waitForCatAtAddress(
  inscriptionId: string,
  expectedAddress: string,
  timeoutMs = 30_000,
): Promise<OrdInscription> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: OrdInscription | undefined;
  while (Date.now() < deadline) {
    const insc = await getOrdInscription(inscriptionId).catch(() => undefined);
    if (insc) {
      lastSeen = insc;
      if (insc.address === expectedAddress) return insc;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(
    `cat ${inscriptionId} not at ${expectedAddress} within ${timeoutMs}ms; ` +
    `last owner: ${lastSeen?.address ?? 'unknown'}`
  );
}

/**
 * Invoke ord's CLI inside the regtest container. Returns stdout
 * trimmed. Errors bubble up via execFileSync's non-zero-exit throw.
 *
 * The container's `command:` runs `ord ... server ...`; this helper
 * spawns a SECOND ord process via `docker exec` for one-shot wallet
 * commands. Both processes read the same regtest bitcoind + index dir,
 * so wallet operations are immediately visible to the running server.
 */
export function ordCli(...args: string[]): string {
  return execFileSync(
    'docker',
    [
      'exec', 'ordpool-e2e-cat21-ord',
      'ord',
      '--regtest',
      '--index-cat21',
      '--index-sats',
      '--index-addresses',
      '--bitcoin-rpc-url=bitcoind:18443',
      '--bitcoin-rpc-username=ordpool',
      '--bitcoin-rpc-password=ordpool',
      '--data-dir=/data',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
}

/**
 * `ord wallet …` requires `--name <NAME>` + `--server-url <URL>` on the
 * wallet subcommand (NOT global). Inside the container the running
 * ord-server is reachable at localhost:8080.
 */
function ordWalletCli(walletName: string, ...subcommandArgs: string[]): string {
  return ordCli(
    'wallet',
    '--name', walletName,
    '--server-url', 'http://localhost:8080',
    ...subcommandArgs,
  );
}

/**
 * Reference buy-offer producer. Asks ord to construct a buyer-side
 * offer for `inscriptionId` at `amountSats`. Returns the PSBT in
 * base64 form, ready for byte-comparison against the SDK's
 * `buildCat21BuyOfferPsbt` output (modulo the `lockTime=21` we set —
 * ord uses `LockTime::ZERO`, we set `21` for the cherry-on-top bonus
 * mint).
 *
 * The ord wallet must be initialised (`ordCreateWallet`) and funded
 * before this is called.
 */
export interface OrdOfferCreateOutput {
  psbt: string;          // base64
  inscription: string;   // inscription id
  seller_address: string;
}

export function ordCreateOffer(
  inscriptionId: string,
  amountSats: number,
  feeRateSatPerVb: number,
  wallet = 'ord',
): OrdOfferCreateOutput {
  const stdout = ordWalletCli(
    wallet,
    'offer', 'create',
    '--inscription', inscriptionId,
    '--amount', `${amountSats}sat`,
    '--fee-rate', String(feeRateSatPerVb),
  );
  return JSON.parse(stdout) as OrdOfferCreateOutput;
}

export interface OrdAddressResponse {
  address: string;
}

/**
 * Create + restore (idempotent) an ord-side bitcoin wallet. ord stores
 * the wallet inside the regtest bitcoind via `wallet_process_psbt`-
 * shaped RPCs; this helper exists so the test setup can construct one
 * deterministically before mining funding blocks to it.
 *
 * Returns a fresh receive address from the wallet.
 */
export function ordCreateWallet(name = 'ord'): string {
  // ord's `wallet create` is idempotent only on the wallet's existence;
  // we ignore the "wallet already exists" error path so the helper can
  // be called from a clean spec setup or a re-run.
  try {
    ordWalletCli(name, 'create');
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (!msg.includes('already exists') && !msg.includes('already loaded')) throw e;
  }
  const stdout = ordWalletCli(name, 'receive');
  const parsed = JSON.parse(stdout) as { addresses?: string[]; address?: string };
  if (parsed.address) return parsed.address;
  if (parsed.addresses && parsed.addresses.length > 0) return parsed.addresses[0];
  throw new Error(`unexpected ord wallet receive shape: ${stdout}`);
}

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
