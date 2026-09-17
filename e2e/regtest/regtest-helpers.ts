// Small helpers shared across regtest E2E specs. Hits the local
// bitcoind RPC + electrs HTTP API directly — no framework, no DI.
//
// Expects the regtest stack to be up via `e2e/regtest-bootstrap.sh`
// and `REGTEST_FUNDED_ADDR` / `REGTEST_FUNDED_WIF` set in env.

import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';

const execFileAsync = promisify(execFile);

const ELECTRS_URL =
  process.env.REGTEST_ELECTRS_URL ??
  `http://localhost:${process.env.E2E_ELECTRS_HOST_PORT ?? 3010}`;
const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';
// Stock ord (no --index-cat21 flag) — see docker-compose.regtest.yml,
// service `ord-stock`. Used by the `inscribe-ord-indexing-roundtrip`
// spec to verify a real upstream-ord recognises the SDK's inscriptions.
export const ORD_STOCK_URL = process.env.REGTEST_ORD_STOCK_URL ?? 'http://localhost:8081';
// The bitcoind container name. Defaults to the SDK's own stack
// (`ordpool-e2e-bitcoind`); consumer repos (cubes-frontend, ordpool)
// stand up their own compose with a different name (e.g.
// `ordpool-e2e-consumer-bitcoind`) and override via env.
const BITCOIND_CONTAINER = process.env.REGTEST_BITCOIND_CONTAINER ?? 'ordpool-e2e-bitcoind';

// The bitcoind WALLET these helpers spend from. Overridable for the same
// reason the container name is: a consumer stack brings the compose up under
// its own project prefix and its bootstrap names the wallet to match, so a
// hardcoded name fails with bitcoind's `-18 Requested wallet does not exist or
// is not loaded`, which reads like a stack that is down rather than a naming
// mismatch.
const RPC_WALLET = process.env.REGTEST_WALLET ?? 'ordpool-e2e';
/** `-rpcwallet=<name>` for a `bitcoin-cli` call, honouring REGTEST_WALLET. */
const RPC_WALLET_ARG = `-rpcwallet=${RPC_WALLET}`;

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
    ['exec', BITCOIND_CONTAINER, 'bitcoin-cli',
     '-regtest', '-rpcuser=ordpool', '-rpcpassword=ordpool', ...args],
    { encoding: 'utf8' },
  ).trim();
}

/** Mine N blocks to a throwaway address. Returns the new tip height. */
export function mineBlocks(n: number): number {
  const address = rpc(RPC_WALLET_ARG, 'getnewaddress', '', 'legacy');
  rpc(RPC_WALLET_ARG, 'generatetoaddress', String(n), address);
  return Number(rpc('getblockcount'));
}

/**
 * Mine a block that INCLUDES the given raw transactions, bypassing mempool
 * relay policy (the `generateblock` RPC). This is how a transaction relay
 * would reject — e.g. one carrying a sub-dust output — reaches the chain
 * out-of-band, exactly as a direct-to-miner submission (Slipstream / MARA)
 * would. Returns the new tip height.
 */
export function mineBlockWithRawTxs(rawTxHexes: string[]): number {
  const address = rpc(RPC_WALLET_ARG, 'getnewaddress', '', 'legacy');
  rpc('generateblock', address, JSON.stringify(rawTxHexes));
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
 * Wait for a UTXO matching `predicate` to appear at `address`.
 * `waitForElectrsSync` only guarantees the block tip is at the
 * target height — electrs still needs additional time to index
 * that block's transactions into per-address UTXO sets. Any
 * spec that calls `getUtxos(addr)` immediately after
 * `mineBlocks(1)` + `waitForElectrsSync(tip)` is racing the
 * address-history pass.
 *
 * `description` is a short human-readable label of what the
 * predicate matches (e.g. `value=100_000_000`,
 * `txid=abc… value=100_000_000`). It surfaces in the timeout
 * error so the failure tells you which UTXO didn't show up.
 */
export async function waitForUtxoMatching(
  address: string,
  predicate: (u: ElectrsUtxo) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<ElectrsUtxo> {
  const deadline = Date.now() + timeoutMs;
  let lastUtxos: ElectrsUtxo[] = [];
  while (Date.now() < deadline) {
    lastUtxos = await getUtxos(address);
    const hit = lastUtxos.find(predicate);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(
    `UTXO matching "${description}" at ${address} didn't appear within ${timeoutMs}ms; got ${JSON.stringify(lastUtxos)}`,
  );
}

/** Common case: poll for a UTXO of exactly `expectedSats`. */
export async function waitForUtxoAt(
  address: string,
  expectedSats: number,
  timeoutMs = 15_000,
): Promise<ElectrsUtxo> {
  return waitForUtxoMatching(
    address,
    u => u.value === expectedSats,
    `value=${expectedSats}`,
    timeoutMs,
  );
}

/**
 * Wait until electrs's address-history index lists `expectedTxid`
 * against `address` (in either the spending or receiving slot).
 * Use this when you need to assert on the SAME tx from multiple
 * addresses' perspectives (e.g. confirm a redirect inscription
 * landed at B and NOT at A) — once the recipient sees the txid,
 * the sender's view is reliably up-to-date from the same
 * electrs.
 */
export async function waitForAddressTxIndexed(
  address: string,
  expectedTxid: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitForUtxoMatching(
    address,
    u => u.txid === expectedTxid,
    `txid=${expectedTxid}`,
    timeoutMs,
  );
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
  const utxos = (await res.json()) as ElectrsUtxo[];

  // One entry per outpoint. Around the moment a transaction confirms, electrs
  // can list the SAME outpoint twice, once confirmed and once not, so a spec
  // that sums this list sees double. Observed on regtest 2026-09-12: two
  // identical `<txid>:0` entries of 500 000 sats for an address that had
  // received 500 000 once. Both copies describe the same output, so keeping
  // either is correct; counting both is not.
  const byOutpoint = new Map<string, ElectrsUtxo>();
  for (const u of utxos) {
    const key = `${u.txid}:${u.vout}`;
    if (!byOutpoint.has(key)) byOutpoint.set(key, u);
  }
  return [...byOutpoint.values()];
}

export async function getTxHex(txid: string): Promise<string> {
  const res = await fetch(`${ELECTRS_URL}/tx/${txid}/hex`);
  if (!res.ok) throw new Error(`tx hex fetch failed: ${res.status} ${await res.text()}`);
  return (await res.text()).trim();
}

/**
 * Fund `paymentAddress` with `amountBtc` on COMMON (mid-block) sats, then wait
 * until electrs and BOTH ord instances have indexed the coin so the mint-time
 * funding-safety scan classifies it `clean` and the orchestrator auto-picks it.
 *
 * ord assigns a tx's input sats to its outputs FIFO by output order, and a
 * regtest coinbase's first sat is the block-first sat, which ord's `--index-sats`
 * rarity model reads as `uncommon`. A plain `sendtoaddress` randomizes the change
 * position, dropping that boundary sat onto the payment output about half the
 * time -> the coin classifies not-clean -> the funding-safety auto-pick excludes
 * it -> the mint has no clean coin to spend. `fundrawtransaction` with
 * `changePosition: 0` forces change to vout 0, so the boundary sat is absorbed by
 * change and the payment at vout 1 inherits later, common sats. A single explicit
 * input keeps exactly one boundary sat, which the vout-0 change fully absorbs.
 * Deterministic clean funding, regardless of which coinbase the wallet selects.
 */
export async function fundCommonSats(paymentAddress: string, amountBtc: number): Promise<void> {
  const unspent = JSON.parse(
    rpc(RPC_WALLET_ARG, 'listunspent', '100'),
  ) as Array<{ txid: string; vout: number; amount: number }>;
  const coin = [...unspent].sort((a, b) => b.amount - a.amount)[0];
  if (!coin) throw new Error('fundCommonSats: no mature coin to fund from');
  const raw = rpc(
    'createrawtransaction',
    JSON.stringify([{ txid: coin.txid, vout: coin.vout }]),
    JSON.stringify([{ [paymentAddress]: amountBtc }]),
  );
  const funded = JSON.parse(
    rpc(RPC_WALLET_ARG, 'fundrawtransaction', raw, JSON.stringify({ changePosition: 0 })),
  ) as { hex: string };
  const signed = JSON.parse(
    rpc(RPC_WALLET_ARG, 'signrawtransactionwithwallet', funded.hex),
  ) as { hex: string };
  rpc(RPC_WALLET_ARG, 'sendrawtransaction', signed.hex);

  const tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForUtxoAt(paymentAddress, Math.round(amountBtc * 1e8));
  // Both ord instances must have indexed the funding block before any content
  // scan, or /output 404s -> scan-failed -> no auto-pick.
  await waitForOrdStockSync(tip);
  await waitForOrdSync(tip);
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
  /**
   * Where the inscription sits, in `<txid>:<vout>:<offset>` form
   * (ord's `SatPoint` serialisation). The `<txid>:<vout>` prefix
   * IS the UTXO; the `<offset>` is the sat offset inside that UTXO
   * (always `0` for cats since they sit on the first sat of vout[0]).
   *
   * Note: ord's `/inscription/<id>` JSON has NO `output` field —
   * `satpoint` is the canonical location identifier. The HTML page
   * rendering shows an `output` field as `<txid>:<vout>` for human
   * readability; it's not in the API response.
   */
  satpoint: string;
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
      'exec', process.env.REGTEST_ORD_CONTAINER ?? 'ordpool-e2e-cat21-ord',
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
 *
 * `--no-sync`: ord's wallet constructor refuses to run when the ord
 * server is even a few blocks behind bitcoind ("`ord server` N blocks
 * behind `bitcoind`"). Jest runs the regtest spec FILES in parallel
 * workers against ONE shared bitcoind, so a sibling spec mining blocks
 * makes the tip a moving target while this wallet command runs — the
 * guard then fires on address derivation or tx construction that don't
 * depend on the exact tip. Every caller that needs the server actually
 * caught up gates it explicitly with `waitForOrdSync` /
 * `waitForOrdStockSync` before READING an inscription, so dropping the
 * constructor's tip check here is safe: the wallet still uses whatever
 * the server has already indexed.
 */
function ordWalletCli(walletName: string, ...subcommandArgs: string[]): string {
  return ordCli(
    'wallet',
    '--no-sync',
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

export interface OrdSendOutput {
  txid: string;
  psbt: string; // base64
  fee: number;
}

/**
 * Reference `ord wallet send` (the stock transfer). `--dry-run` returns the
 * constructed PSBT without broadcasting, for byte-comparison against the SDK's
 * transfer. `postageSats` maps to ord's `--postage` (default 10000 when
 * omitted). The wallet must OWN the inscription being sent.
 */
export function ordWalletSend(
  recipientAddress: string,
  inscriptionId: string,
  feeRateSatPerVb: number,
  postageSats?: number,
  wallet = 'ord',
): OrdSendOutput {
  const args = ['send', '--dry-run', '--fee-rate', String(feeRateSatPerVb)];
  if (postageSats !== undefined) args.push('--postage', `${postageSats}sat`);
  args.push(recipientAddress, inscriptionId);
  return JSON.parse(ordWalletCli(wallet, ...args)) as OrdSendOutput;
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
/**
 * Whether an `execFileSync` failure carries any of `needles`, looking at the
 * child's stderr and stdout as well as the Error's own message. ord prints its
 * diagnostics to stderr, so `message` alone misses them.
 */
function ordCliErrorSays(e: unknown, ...needles: string[]): boolean {
  const err = e as { message?: string; stderr?: unknown; stdout?: unknown };
  const text = [err.message, err.stderr, err.stdout]
    .map(part => (part == null ? '' : String(part)))
    .join('\n');
  return needles.some(n => text.includes(n));
}

export function ordCreateWallet(name = 'ord'): string {
  // ord's `wallet create` is idempotent only on the wallet's existence;
  // we ignore the "wallet already exists" error path so the helper can
  // be called from a clean spec setup or a re-run.
  try {
    ordWalletCli(name, 'create');
  } catch (e) {
    // The child's own text lands on `stderr`; `message` is a generic
    // non-zero-exit string. Matching only `message` re-throws on a wallet that
    // already exists, so this stops being idempotent across local re-runs. CI
    // never sees it, because its stack is always fresh.
    if (!ordCliErrorSays(e, 'already exists', 'already loaded')) throw e;
  }
  const stdout = ordWalletCli(name, 'receive');
  const parsed = JSON.parse(stdout) as { addresses?: string[]; address?: string };
  if (parsed.address) return parsed.address;
  if (parsed.addresses && parsed.addresses.length > 0) return parsed.addresses[0];
  throw new Error(`unexpected ord wallet receive shape: ${stdout}`);
}

/**
 * Write arbitrary bytes to a file inside the cat21-ord container (via
 * base64 to survive any byte value / the shell). Used to feed `ord wallet
 * inscribe --file` a known content for byte-parity comparison.
 */
export function writeCat21OrdFile(containerPath: string, content: Uint8Array): void {
  const b64 = Buffer.from(content).toString('base64');
  execFileSync(
    'docker',
    ['exec', 'ordpool-e2e-cat21-ord', 'sh', '-c', `printf %s '${b64}' | base64 -d > '${containerPath}'`],
    { encoding: 'utf8' },
  );
}

/**
 * Run ord's OWN `wallet inscribe` (the reference implementation). Returns
 * the commit + reveal txids. `--no-backup` avoids ord's recovery-key
 * import into bitcoind (which fails on the shared regtest wallet). The
 * envelope-construction code (`append_reveal_script`) is identical to
 * stock ord, so the reveal's envelope bytes are ord-canonical.
 */
export function ordWalletInscribe(
  walletName: string,
  containerFilePath: string,
  feeRateSatPerVb: number,
  extraArgs: string[] = [],
): { commit: string; reveal: string } {
  const stdout = ordWalletCli(
    walletName,
    'inscribe',
    '--no-backup',
    '--fee-rate', String(feeRateSatPerVb),
    '--file', containerFilePath,
    ...extraArgs,
  );
  const parsed = JSON.parse(stdout) as { commit: string; reveal: string };
  return { commit: parsed.commit, reveal: parsed.reveal };
}

/**
 * Assert the cat actually LANDED: output 0 of the confirmed tx pays the
 * recipient ordinals address with the fresh-cat postage. Ordinal theory
 * assigns the cat to the first sat of the first output, so a builder or
 * signer regression that swaps output order (change at vout 0) or routes
 * vout 0 to the payment address mints the cat onto the WRONG sat while
 * locktime/parser checks stay green. Chain-truth from electrs, not from
 * locally decoded bytes.
 */
export function assertCatLandsAtRecipient(
  tx: EsploraTx,
  recipientAddress: string,
  expectedPostageSats = 546,
): void {
  const vout0 = tx.vout[0] as { scriptpubkey_address?: string; value?: number };
  if (vout0?.scriptpubkey_address !== recipientAddress) {
    throw new Error(
      `Cat did NOT land at the recipient: vout[0] pays ${vout0?.scriptpubkey_address ?? '(none)'}, ` +
      `expected ${recipientAddress}`,
    );
  }
  if (vout0.value !== expectedPostageSats) {
    throw new Error(
      `Cat output has wrong postage: vout[0].value = ${vout0.value}, expected ${expectedPostageSats}`,
    );
  }
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

// ─── stock-ord helpers (no --index-cat21) ────────────────────────────
//
// Used by `inscribe-ord-indexing-roundtrip.spec.ts` to verify that
// a real upstream-style ord recognises the SDK's inscriptions. The
// cat21-ord container above runs with --index-cat21 which filters
// out regular inscriptions; stock ord indexes them like upstream.

/** Build an inscription id from txid + output index (`<txid>i<index>`). */
export function inscriptionId(txid: string, index = 0): string {
  return `${txid}i${index}`;
}

/**
 * Poll stock ord's HTTP server until it answers `/status` with a
 * 2xx. Same warm-up rationale as `waitForOrdReady`.
 */
export async function waitForOrdStockReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(`${ORD_STOCK_URL}/status`).then(r => r.ok).catch(() => false);
    if (ok) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`stock ord didn't respond on /status within ${timeoutMs}ms (is the ord-stock profile up?)`);
}

/**
 * Block until stock ord has indexed up to (at least) `targetHeight`.
 * ord's indexer lags bitcoind by a few hundred ms; without this gate
 * the inscription-lookup assertions race the indexer.
 */
export async function waitForOrdStockSync(targetHeight: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetch(`${ORD_STOCK_URL}/status`, {
      headers: { Accept: 'application/json' },
    }).then(r => r.ok ? r.json() : null).catch(() => null) as { height?: number } | null;
    if (status && typeof status.height === 'number' && status.height >= targetHeight) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`stock ord didn't reach height ${targetHeight} within ${timeoutMs}ms`);
}

export interface StockOrdInscription {
  /** Address currently holding the inscription. */
  address: string;
  /** UTXO carrying the inscription, `<txid>:<vout>` form. */
  output: string;
  /** Sats locked in the inscription's UTXO. */
  value: number;
  /** ord's inscription number (sequential per stock-ord index). */
  number: number;
  /** The inscription id, `<txid>i<index>`. */
  id: string;
  /** Content-type recorded in the envelope (e.g. 'text/plain;charset=utf-8'). */
  content_type?: string | null;
  /** Body length in bytes — useful for size assertions. */
  content_length?: number | null;
  /** Parent inscription ids (ord provenance). Present + non-empty on a child. */
  parents?: string[];
  /** Charms on the inscription (e.g. 'vindicated', 'cursed'). */
  charms?: string[];
  /** Current satpoint `<txid>:<vout>:<offset>`. */
  satpoint?: string;
  /** The sat the inscription is on (ord runs with `--index-sats`). */
  sat?: number | null;
}

/**
 * Fetch an inscription record from stock ord. Throws on any non-2xx;
 * callers wrap in `waitForOrdStockInscription` if they need to poll.
 */
export async function getStockOrdInscription(id: string): Promise<StockOrdInscription> {
  const res = await fetch(`${ORD_STOCK_URL}/inscription/${id}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`stock ord /inscription/${id} returned ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<StockOrdInscription>;
}

/**
 * Inscription IDs currently located on an output, per stock ord's
 * `/output/<txid:vout>` JSON (empty when the output carries none). Used to
 * guarantee a funding UTXO sits on an un-inscribed sat before an inscription is
 * built on it: inscribing a sat that already carries one is a reinscription,
 * which stock ord curses (post-jubilee: the `vindicated` charm). The shared
 * `ordpool-e2e` pool can hand out such a sat (inscribe specs deposit reveal
 * outputs to SDK addresses whose WIF lives in that wallet), so a blessing test
 * must re-fund until this returns empty.
 */
export async function getStockOrdOutputInscriptions(outpoint: string): Promise<string[]> {
  const res = await fetch(`${ORD_STOCK_URL}/output/${outpoint}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`stock ord /output/${outpoint} returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { inscriptions?: string[] };
  return body.inscriptions ?? [];
}

/** Stock ord's `/output/<outpoint>` JSON, the fields the specs read. */
export interface StockOrdOutput {
  value: number;
  inscriptions: string[];
  /** `[start, end)` sat ranges in output order (ord runs with `--index-sats`). */
  sat_ranges: Array<[number, number]>;
  /** Rune balances, keyed by spaced name. `null` when ord has no rune index. */
  runes?: Record<string, { amount: number; divisibility: number; symbol: string }> | null;
  /** The output's scriptPubKey, hex, as the chain itself holds it. */
  script_pubkey: string;
  address: string;
}

/** A regtest coin seeded so that it really carries a rune balance. */
export interface SeededRuneCoin {
  txid: string;
  vout: number;
  /** The coin's value in sats. */
  value: number;
  /** The rune's spaced name, as ord spells it. */
  runeName: string;
  /** Base units held on this coin, as ord's `/output` reports them (a NUMBER). */
  amount: number;
  divisibility: number;
  symbol: string;
  /** The transaction that etched it, for an etching-link assertion. */
  etchingTxid: string;
  address: string;
}

/**
 * Etch a rune on regtest and seed a coin carrying its premine.
 *
 * This is the half of the funding-safety guard that was previously impossible
 * to prove: cat21-ord never indexes runes, and the stock ord only does so with
 * `--index-runes`, which both composes now pass. Without it `/output.runes` is
 * always `null` and a rune row or rune refusal cannot be exercised at all.
 *
 * Etching is not a single call. ord commits the rune name, waits
 * `COMMIT_CONFIRMATIONS` (6) for that commitment to mature, then reveals, and
 * it blocks for the whole wait. So blocks have to be mined CONCURRENTLY, and
 * not too fast: ord refuses to act while its index is behind bitcoind, so an
 * aggressive miner makes the etch fail with "N blocks behind". `--no-backup`
 * is required too, because ord otherwise imports a recovery descriptor into
 * bitcoind and that import fails here.
 *
 * Every one of those was found by doing it rather than by reading about it.
 */
export async function seedRuneCoin(
  options: {
    address?: string;
    runeName?: string;
    walletName?: string;
    feeRate?: number;
    /**
     * The value of the coin the rune lands on, when `address` is given.
     *
     * ord's `wallet send` defaults to 10 000 sat postage. That matters for a
     * guard spec: best-fit selection takes the SMALLEST covering coin, so a
     * rune coin the caller cannot position is a coin an unguarded selection
     * would never have picked, and its survival proves nothing.
     */
    valueSats?: number;
  } = {},
): Promise<SeededRuneCoin> {
  const runeName = options.runeName ?? uniqueRuneName();
  const walletName = options.walletName ?? 'rune-etcher';
  const feeRate = options.feeRate ?? 2;

  ordStockCreateWallet(walletName);
  const ordAddress = JSON.parse(ordStockWalletCli(walletName, 'receive')) as
    { address?: string; addresses?: string[] };
  const fundTo = ordAddress.address ?? ordAddress.addresses?.[0];
  if (!fundTo) throw new Error('seedRuneCoin: ord wallet gave no receive address');
  await sendFromCleanFunderCoin({ [fundTo]: '5.0' });

  writeOrdStockFile('/tmp/rune-payload.txt', new TextEncoder().encode(`rune etch ${runeName}`));
  const batch = [
    'mode: separate-outputs',
    'postage: 10000',
    'inscriptions:',
    '  - file: /tmp/rune-payload.txt',
    'etching:',
    `  rune: ${runeName}`,
    '  divisibility: 2',
    '  premine: 1000.00',
    '  supply: 1000.00',
    '  symbol: "@"',
    '  turbo: true',
    '',
  ].join('\n');
  writeOrdStockFile('/tmp/rune-batch.yaml', new TextEncoder().encode(batch));

  // Mine through the commitment's maturity while ord runs, slowly enough that
  // ord's indexer keeps pace.
  //
  // The etch MUST be the async CLI. `ord wallet batch` does not return until
  // the commitment has six confirmations, and on regtest nothing produces
  // those blocks unless this loop does. Against the SYNCHRONOUS call the two
  // deadlock outright: execFileSync owns the event loop, so this timer never
  // fires, the blocks are never mined, the commitment never matures, and the
  // call waits forever.
  let mining = true;
  const miner = (async () => {
    await new Promise((r) => setTimeout(r, 8_000));
    while (mining) {
      try { mineBlocks(1); } catch { /* the etch may already be done */ }
      await new Promise((r) => setTimeout(r, 6_000));
    }
  })();

  let result: { reveal: string; rune?: { location?: string; rune?: string } };
  try {
    result = JSON.parse(await ordStockWalletCliAsync(
      walletName, 'batch', '--fee-rate', String(feeRate), '--no-backup', '--batch', '/tmp/rune-batch.yaml',
    )) as typeof result;
  } finally {
    mining = false;
    await miner;
  }

  const location = result.rune?.location;
  if (!location) throw new Error(`seedRuneCoin: ord reported no rune location: ${JSON.stringify(result)}`);
  const [txid, voutText] = location.split(':');
  const vout = Number(voutText);

  const tip = mineBlocks(2);
  await waitForElectrsSync(tip);
  await waitForOrdStockSync(tip);

  const output = await getStockOrdOutput(`${txid}:${vout}`);
  const entry = output.runes?.[runeName];
  if (!entry) {
    throw new Error(
      `seedRuneCoin: stock ord reports no rune on ${txid}:${vout} (${JSON.stringify(output.runes)}). ` +
      'Is --index-runes on? Without it /output.runes is always null and no rune spec can prove anything.',
    );
  }

  const etching = await fetch(`${ORD_STOCK_URL}/rune/${encodeURIComponent(runeName)}`, {
    headers: { Accept: 'application/json' },
  }).then((r) => r.json()) as { entry?: { etching?: string } };

  let seeded = { txid, vout, value: output.value, address: output.address };
  if (options.address !== undefined) {
    // The funding scan reads the PAYMENT address, so a rune left at ord's own
    // address is a coin the scan never sees.
    const sendArgs = ['send', '--fee-rate', String(feeRate)];
    if (options.valueSats !== undefined) sendArgs.push('--postage', `${options.valueSats}sat`);
    sendArgs.push(options.address, `1000:${runeName}`);
    const sent = ordStockWalletCli(walletName, ...sendArgs);
    const sentTxid = (JSON.parse(sent) as { txid: string }).txid;
    const sentTip = mineBlocks(1);
    await waitForElectrsSync(sentTip);
    await waitForOrdStockSync(sentTip);
    const moved = await findRuneOutput(sentTxid, runeName, options.address);
    if (options.valueSats !== undefined && moved.value !== options.valueSats) {
      throw new Error(
        `seedRuneCoin: the rune landed on a ${moved.value}-sat coin, not the ${options.valueSats} asked for. ` +
        'A guard spec positions this coin by value, so a different one silently changes what is proven.',
      );
    }
    seeded = { txid: sentTxid, vout: moved.vout, value: moved.value, address: moved.address };
  }

  return {
    ...seeded,
    runeName,
    amount: entry.amount,
    divisibility: entry.divisibility,
    symbol: entry.symbol,
    etchingTxid: etching.entry?.etching ?? '',
  };
}

/**
 * The output of `txid` that actually carries `runeName`, at `address`.
 *
 * A rune send is not a plain payment: ord emits an OP_RETURN runestone plus
 * recipient and change outputs, and the edict inside the runestone decides
 * which output receives the rune. The index is ord's to choose, so assuming
 * one silently hands back a coin carrying no rune, which then reads as a
 * perfectly clean coin to anything that inspects it. Ask ord instead.
 */
async function findRuneOutput(
  txid: string,
  runeName: string,
  address: string,
): Promise<{ vout: number; value: number; address: string }> {
  const raw = JSON.parse(rpc('getrawtransaction', txid, 'true')) as { vout: Array<unknown> };
  const seen: string[] = [];
  for (let vout = 0; vout < raw.vout.length; vout++) {
    const output = await getStockOrdOutput(`${txid}:${vout}`);
    if (!output.runes?.[runeName]) continue;
    seen.push(`${vout}@${output.address}`);
    if (output.address === address) return { vout, value: output.value, address: output.address };
  }
  throw new Error(
    `findRuneOutput: no output of ${txid} carries ${runeName} at ${address}. ` +
    `Outputs holding the rune: ${seen.length ? seen.join(', ') : 'none'}.`,
  );
}

/**
 * The rune coin carries a notable sat too, for the same reason the inscribed
 * one does, so assert the RUNE specifically and never a generic "has content"
 * signal. When asserting rendered text, note that a rune pile's symbol is
 * preceded by a NON-BREAKING space (U+00A0), because ord's `Display for Pile`
 * emits one and `formatRunePile` matches it. `toContain('1000 @')` written with
 * an ordinary space does not match, and the failure prints as
 * Expected "1000 @" / Received "1000 @" with nothing visibly different.
 */
/** A fresh spaced rune name; ord refuses a name already etched on this chain. */
function uniqueRuneName(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let n = Date.now();
  let suffix = '';
  while (suffix.length < 8) { suffix = alphabet[n % 26] + suffix; n = Math.floor(n / 26); }
  return `ORDPOOL\u2022${suffix}`;
}

/** A regtest coin seeded so that it really carries an inscription. */
export interface SeededInscribedCoin {
  txid: string;
  vout: number;
  /** The coin's value in sats. Sized to be a real funding candidate. */
  value: number;
  /** The inscription it carries, as stock ord reports it. */
  inscriptionId: string;
  /** Where the coin sits. */
  address: string;
}

/**
 * Seed a coin that really carries an inscription, for the spec that proves the
 * funding-safety guard REFUSES it.
 *
 * Two properties decide whether such a spec proves anything, and both are easy
 * to get wrong:
 *
 * 1. **It has to be big enough to be a funding candidate.** At ord's default
 *    546-sat postage the scan may never consider the coin at all, because it
 *    cannot cover the transaction being funded. The guard is then never asked
 *    the question, and a spec that "passes" has proven nothing. `postageSats`
 *    defaults to 2 000 000, comfortably above a mint's funding need, so the
 *    coin is a genuine candidate the scan is forced to rule on.
 * 2. **It goes to the PAYMENT address.** The funding scan reads UTXOs at the
 *    payment address, not the ordinals address. Seeding an inscription to the
 *    ordinals address produces a coin the scan never sees.
 *
 * The inscription is made through stock ord's own wallet, so stock ord indexes
 * it and `/output/<outpoint>` reports it under `inscriptions`. That is the
 * field cat21-ord does not have, which is why a guard spec must read the stock
 * ord and why pointing it at cat21-ord is the mutation that proves the guard
 * depends on it.
 *
 * Mines and waits for electrs and stock ord, so the coin is scannable on
 * return.
 *
 * **The coin usually carries a notable sat too, so never assert on a generic
 * "has content" signal.** Every coin on regtest descends from a coinbase, and
 * a coinbase output opens on its block's first sat, which ordinal theory calls
 * `uncommon`; both ords run with `--index-sats`, so both report it. A spec that
 * checks only "an asset was found" therefore passes whether the inscription was
 * detected or not, which is the shape that cannot fail and proves nothing.
 * Assert the INSCRIPTION ID specifically: it comes from the stock ord's
 * `inscriptions` field, the one cat21-ord does not have, so it is the only
 * assertion the mutation can move.
 *
 * Observed 2026-09-14: a consumer's guard spec went green against cat21-ord
 * because the generic asset badge fired on that rare sat; re-asserting on the
 * rendered inscription id made the same mutation go red.
 */
export async function seedInscribedCoin(
  options: {
    address: string;
    /** Preferred name, matching every other seed helper. */
    valueSats?: number;
    /** Older name for the same thing. */
    postageSats?: number;
    walletName?: string;
    feeRate?: number;
  },
): Promise<SeededInscribedCoin> {
  // The 2 000 000 default is deliberately large for callers that just need an
  // inscribed coin to exist. It is the WRONG value for a funding-guard spec:
  // best-fit selection takes the SMALLEST covering coin, so a coin this size is
  // never a candidate and the spec passes with the guard deleted. Guard specs
  // pass `valueSats` explicitly, which `seedDirtyCoin` requires.
  const postageSats = options.valueSats ?? options.postageSats ?? 2_000_000;
  const walletName = options.walletName ?? 'seed-inscribed';
  const feeRate = options.feeRate ?? 2;

  // Fund ord's own wallet with room for the postage plus fees.
  const needBtc = ((postageSats + 1_000_000) / 1e8).toFixed(8);
  await fundOrdStockWallet(walletName, needBtc);

  const body = `seeded inscription for the funding-safety guard ${Date.now()}`;
  const path = `/tmp/seed-inscribed-${Date.now()}.txt`;
  writeOrdStockFile(path, new TextEncoder().encode(body));

  const { reveal } = ordStockWalletInscribe(walletName, path, feeRate, [
    '--postage', `${postageSats}sat`,
    '--destination', options.address,
  ]);

  const tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdStockSync(tip);

  const inscriptionId = `${reveal}i0`;
  await waitForOrdStockInscription(inscriptionId);

  // Read the coin back from ord rather than assuming the reveal's shape, and
  // refuse to hand back a coin ord does not actually report as inscribed:
  // a guard spec seeded with a clean coin would pass while proving nothing.
  const outpoint = `${reveal}:0`;
  const output = await getStockOrdOutput(outpoint);
  if (!output.inscriptions?.includes(inscriptionId)) {
    throw new Error(
      `seedInscribedCoin: stock ord does not report ${inscriptionId} on ${outpoint}; ` +
      `it reports ${JSON.stringify(output.inscriptions)}. The coin would not exercise the guard.`,
    );
  }
  if (output.value !== postageSats) {
    throw new Error(
      `seedInscribedCoin: ${outpoint} holds ${output.value} sats, not the ${postageSats} asked for. ` +
      'A guard spec positions this coin by value, so a different one silently changes what is proven.',
    );
  }

  return { txid: reveal, vout: 0, value: output.value, inscriptionId, address: output.address };
}

/** A regtest coin seeded so that it carries a notable sat. */
export interface SeededRareSatCoin {
  txid: string;
  vout: number;
  /** The coin's value in sats. */
  value: number;
  /** The notable sat it carries, at offset 0. */
  sat: number;
  /** ord's own rarity for that sat: `uncommon` on an ordinary regtest block. */
  rarity: string;
  /** Where the coin sits. */
  address: string;
}

/**
 * Seed a coin that really carries a notable sat, for a spec that needs a
 * rare-sat row to render against a scanned coin rather than against fabricated
 * state.
 *
 * A regtest coinbase's FIRST sat is a block-first sat, which ord's rarity model
 * reads as `uncommon`. So the coin is funded from one explicit coinbase input
 * with change forced AFTER the payment, which leaves the payment output holding
 * the input's earliest sats, the boundary sat among them, at offset 0.
 *
 * The rarity is read back from ord rather than asserted here, so a caller
 * checks a rendered row against ord's own verdict. Blocks are mined and both
 * electrs and stock ord are waited on, so the coin is scannable when this
 * returns.
 *
 * @param address Where to seed it. Defaults to a fresh address of the regtest
 *                wallet; pass the wallet address under test to have the coin
 *                appear in that wallet's scan.
 */
export async function seedRareSatCoin(
  options: { address?: string; valueSats?: number } = {},
): Promise<SeededRareSatCoin> {
  const address = options.address ?? rpc(RPC_WALLET_ARG, 'getnewaddress').trim();
  // The notable sat is the FIRST sat of vout 0, and FIFO puts it there whatever
  // that output is worth, so the value is free to be whatever the caller needs.
  // It matters because a guard spec has to seed the coin where an unguarded
  // best-fit selection would actually pick it, and best-fit takes the SMALLEST
  // covering coin: a rare-sat coin seeded at half a bitcoin is never a
  // candidate, so its survival proves nothing.
  const valueSats = options.valueSats ?? 50_000_000;
  // It has to be a real COINBASE output, not merely the biggest coin. Only a
  // coinbase begins at a block's first sat; a change output from an earlier
  // seed begins mid-block, and funding from one yields a common sat. Repeated
  // seeding exhausts the pristine coinbases, so the type is checked rather
  // than assumed from the size.
  const unspent = JSON.parse(rpc(RPC_WALLET_ARG, 'listunspent', '100')) as Array<{
    txid: string; vout: number; amount: number;
  }>;
  const byValue = [...unspent].sort((a, b) => b.amount - a.amount);
  let coinbase: { txid: string; vout: number } | undefined;
  for (const candidate of byValue) {
    if (candidate.vout !== 0) continue; // a coinbase pays its subsidy to vout 0
    const tx = JSON.parse(rpc('getrawtransaction', candidate.txid, '1')) as {
      vin: Array<{ coinbase?: string }>;
    };
    if (tx.vin[0]?.coinbase !== undefined) { coinbase = candidate; break; }
  }
  if (!coinbase) {
    throw new Error(
      'seedRareSatCoin: no unspent mature COINBASE output to seed from. ' +
      'Mine more blocks, or the chain has had its block-first sats spent.',
    );
  }

  const raw = rpc(
    'createrawtransaction',
    JSON.stringify([{ txid: coinbase.txid, vout: coinbase.vout }]),
    JSON.stringify([{ [address]: Number((valueSats / 1e8).toFixed(8)) }]),
  );
  // changePosition 1 keeps the payment at vout 0, so it inherits the input's
  // first sats. Change after it takes the rest.
  const funded = JSON.parse(
    rpc(RPC_WALLET_ARG, 'fundrawtransaction', raw, JSON.stringify({ changePosition: 1 })),
  ) as { hex: string };
  const signed = JSON.parse(
    rpc(RPC_WALLET_ARG, 'signrawtransactionwithwallet', funded.hex),
  ) as { hex: string };
  const txid = rpc('sendrawtransaction', signed.hex).trim();

  const tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdStockSync(tip);

  const output = await getStockOrdOutput(`${txid}:0`);
  const sat = output.sat_ranges[0][0];
  const { rarity } = await getStockOrdSat(sat);
  if (rarity === 'common') {
    throw new Error(
      `seedRareSatCoin: the seeded coin's first sat ${sat} is common, not notable. ` +
      'The chosen input was not a coinbase, or its first sats were already spent.',
    );
  }

  if (output.value !== valueSats) {
    throw new Error(
      `seedRareSatCoin: ${txid}:0 holds ${output.value} sats, not the ${valueSats} asked for. ` +
      'A guard spec positions this coin by value, so a different one silently changes what is proven.',
    );
  }

  return { txid, vout: 0, value: output.value, sat, rarity, address: output.address };
}

/** ord's own verdict on a sat: `GET /sat/<sat>`, which carries its rarity. */
export async function getStockOrdSat(sat: number): Promise<{ rarity: string; number: number }> {
  const res = await fetch(`${ORD_STOCK_URL}/sat/${sat}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`stock ord /sat/${sat} returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { rarity: string; number: number };
}

export async function getStockOrdOutput(outpoint: string): Promise<StockOrdOutput> {
  const res = await fetch(`${ORD_STOCK_URL}/output/${outpoint}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`stock ord /output/${outpoint} returned ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<StockOrdOutput>;
}

/** A fresh receive address of an ord-stock wallet (`ord wallet receive`). */
export function ordStockWalletReceive(walletName: string): string {
  const parsed = JSON.parse(ordStockWalletCli(walletName, 'receive')) as { addresses?: string[]; address?: string };
  const address = parsed.address ?? parsed.addresses?.[0];
  if (address === undefined) throw new Error(`unexpected ord wallet receive shape for ${walletName}`);
  return address;
}

/** `ord wallet outputs` in the ord-stock container. */
export function ordStockWalletOutputs(walletName: string): Array<{ output: string; amount: number; inscriptions?: string[] }> {
  return JSON.parse(ordStockWalletCli(walletName, 'outputs')) as Array<{ output: string; amount: number; inscriptions?: string[] }>;
}

/**
 * A fresh 1 BTC P2WPKH UTXO in the `ordpool-e2e` wallet whose first sat
 * carries no inscription, for building SDK inscriptions that stock ord must
 * index as blessed. Inscribing onto an already-inscribed sat is a
 * reinscription, and the pool can hand one out (see
 * {@link getStockOrdOutputInscriptions}), so this re-funds until it gets a
 * clean one. Sign the SDK commit with `walletprocesspsbt` on `ordpool-e2e`.
 */
export async function fundUninscribed(): Promise<{
  fundingAddr: string;
  fundingPubkey: Uint8Array;
  utxo: { txid: string; vout: number; value: number };
}> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const fundingAddr = rpc(RPC_WALLET_ARG, 'getnewaddress', '', 'bech32');
    const fundingPubkey = new Uint8Array(Buffer.from(JSON.parse(rpc(RPC_WALLET_ARG, 'getaddressinfo', fundingAddr)).pubkey, 'hex'));
    rpc(RPC_WALLET_ARG, 'sendtoaddress', fundingAddr, '1.0');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);
    const utxo = await waitForUtxoAt(fundingAddr, 100_000_000);
    if ((await getStockOrdOutputInscriptions(`${utxo.txid}:${utxo.vout}`)).length === 0) {
      return { fundingAddr, fundingPubkey, utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value } };
    }
    // The pool handed us a previously-inscribed sat; discard and try again.
  }
  throw new Error('no un-inscribed 1 BTC funding UTXO after 8 attempts');
}

/**
 * Fetch the raw body bytes of an inscription from stock ord's
 * `/content/<id>` endpoint. ord returns the bytes verbatim with the
 * envelope's content-type as the response Content-Type header — same
 * shape every recursive-inscription consumer sees.
 */
export async function getStockOrdContent(
  id: string,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const res = await fetch(`${ORD_STOCK_URL}/content/${id}`);
  if (!res.ok) {
    throw new Error(`stock ord /content/${id} returned ${res.status}: ${await res.text()}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { bytes: buf, contentType: res.headers.get('content-type') };
}

/**
 * Poll until stock ord serves the inscription. ord indexes inscriptions
 * one or two blocks after the reveal lands; this helper hides the
 * polling boilerplate.
 */
export async function waitForOrdStockInscription(
  id: string,
  timeoutMs = 30_000,
): Promise<StockOrdInscription> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await getStockOrdInscription(id);
    } catch (e) {
      lastError = e;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(
    `stock ord did not surface inscription ${id} within ${timeoutMs}ms; ` +
    `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Stock ord: the reference implementation for byte-parity.
//
// `ordCli` above execs into the cat21-ord container, which runs with
// `--index-cat21` and therefore indexes ONLY cats, never regular
// inscriptions. That is fine for building an envelope from nothing, and it is
// fatal the moment an inscription REFERENCES another: ord's `wallet
// inscribe` checks every `--gallery`, `--parent` and `--delegate` id against
// its server's index and refuses with "referenced inscriptions do not exist"
// when the server has never indexed them.
//
// So anything that references another inscription has to be built by the
// stock-ord container, which indexes everything. These mirror the cat21-ord
// helpers exactly, minus `--index-cat21`.
// ---------------------------------------------------------------------------

const ORD_STOCK_CONTAINER = process.env.REGTEST_ORD_STOCK_CONTAINER ?? 'ordpool-e2e-ord-stock';

/** The `docker exec` argv for one stock-ord CLI invocation. */
function ordStockCliArgs(args: string[]): string[] {
  return [
    'exec', ORD_STOCK_CONTAINER,
    'ord',
    '--regtest',
    '--index-sats',
    '--index-addresses',
    '--bitcoin-rpc-url=bitcoind:18443',
    '--bitcoin-rpc-username=ordpool',
    '--bitcoin-rpc-password=ordpool',
    '--data-dir=/data',
    ...args,
  ];
}

export function ordStockCli(...args: string[]): string {
  return execFileSync('docker', ordStockCliArgs(args), { encoding: 'utf8' }).trim();
}

/**
 * Same invocation, without blocking the event loop.
 *
 * `execFileSync` holds the loop for the whole command, so any caller that has
 * to keep doing something WHILE ord runs must use this one. The etching path
 * is the case that forces it: `ord wallet batch` does not return until the
 * commitment has six confirmations, and on regtest those blocks only exist if
 * something mines them meanwhile. Mine from a timer against the sync call and
 * the two deadlock: the call owns the loop, the timer never fires, the blocks
 * are never mined, the call waits forever.
 */
export async function ordStockCliAsync(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', ordStockCliArgs(args), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** The wallet-subcommand argv shared by the sync and async forms. */
function ordStockWalletArgs(walletName: string, subcommandArgs: string[]): string[] {
  return [
    'wallet',
    '--no-sync',
    '--name', walletName,
    '--server-url', 'http://localhost:8080',
    ...subcommandArgs,
  ];
}

function ordStockWalletCli(walletName: string, ...subcommandArgs: string[]): string {
  return ordStockCli(...ordStockWalletArgs(walletName, subcommandArgs));
}

/** Non-blocking `ord wallet …`, for commands that need blocks mined while they run. */
function ordStockWalletCliAsync(walletName: string, ...subcommandArgs: string[]): Promise<string> {
  return ordStockCliAsync(...ordStockWalletArgs(walletName, subcommandArgs));
}

export function ordStockCreateWallet(name: string): string {
  try {
    ordStockWalletCli(name, 'create');
  } catch (e) {
    // The child's own text lands on `stderr`; `message` is a generic
    // non-zero-exit string. Matching only `message` re-throws on a wallet that
    // already exists, so this stops being idempotent across local re-runs. CI
    // never sees it, because its stack is always fresh.
    if (!ordCliErrorSays(e, 'already exists', 'already loaded')) throw e;
  }
  const stdout = ordStockWalletCli(name, 'receive');
  const parsed = JSON.parse(stdout) as { addresses?: string[]; address?: string };
  if (parsed.address) return parsed.address;
  if (parsed.addresses && parsed.addresses.length > 0) return parsed.addresses[0];
  throw new Error(`unexpected ord wallet receive shape: ${stdout}`);
}

/**
 * Write `content` to `containerPath` inside the ord-stock container. The
 * bytes go over stdin, so any size works (an argv string is capped by the
 * OS's argument-length limit).
 */
export function writeOrdStockFile(containerPath: string, content: Uint8Array): void {
  execFileSync(
    'docker',
    ['exec', '-i', ORD_STOCK_CONTAINER, 'sh', '-c', `cat > '${containerPath}'`],
    { input: content },
  );
}

export function ordStockWalletInscribe(
  walletName: string,
  containerFilePath: string,
  feeRateSatPerVb: number,
  extraArgs: string[] = [],
): { commit: string; reveal: string } {
  const stdout = ordStockWalletCli(
    walletName,
    'inscribe',
    '--no-backup',
    '--fee-rate', String(feeRateSatPerVb),
    '--file', containerFilePath,
    ...extraArgs,
  );
  const parsed = JSON.parse(stdout) as { commit: string; reveal: string };
  return { commit: parsed.commit, reveal: parsed.reveal };
}

/**
 * `ord wallet batch --fee-rate <R> --batch <FILE>` in the ord-stock
 * container. `batchYaml` is the batchfile's text; file paths inside it are
 * container paths (write them with {@link writeOrdStockFile} first).
 */
export function ordStockWalletBatch(
  walletName: string,
  batchYaml: string,
  feeRateSatPerVb: number,
): { commit: string; reveal: string; inscriptions: Array<{ id: string; location: string }> } {
  const path = `/tmp/batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.yaml`;
  writeOrdStockFile(path, new TextEncoder().encode(batchYaml));
  const stdout = ordStockWalletCli(
    walletName,
    'batch',
    '--no-backup',
    '--fee-rate', String(feeRateSatPerVb),
    '--batch', path,
  );
  return JSON.parse(stdout) as { commit: string; reveal: string; inscriptions: Array<{ id: string; location: string }> };
}

/**
 * Create a stock-ord wallet and fund it by TRANSFER, mining one block.
 *
 * Mining coinbases straight to an ord wallet looks simpler and is wrong
 * twice over. It burns ~100 blocks per wallet to reach coinbase maturity, and
 * on regtest the subsidy halves every 150 blocks, so late in a long run a
 * fresh wallet receives coinbases worth a few satoshis and ord reports "not
 * enough cardinal UTXOs". The shared `ordpool-e2e` funder holds coins mined at
 * low height, so a transfer from it is worth the same whenever it happens.
 *
 * One funding UTXO is enough for a whole spec: each ord inscribe spends it
 * and returns change, and every caller mines a block after inscribing, so the
 * change is confirmed before the next inscribe needs it.
 */
export async function fundOrdStockWallet(walletName: string, btc = '2.0'): Promise<string> {
  const addr = ordStockCreateWallet(walletName);
  const wantSats = Math.round(Number(btc) * 1e8);
  await sendFromCleanFunderCoin({ [addr]: btc });

  const balance = JSON.parse(ordStockWalletCli(walletName, 'balance')) as { cardinal?: number };
  if ((balance.cardinal ?? 0) < wantSats) {
    throw new Error(
      `fundOrdStockWallet: sent ${btc} BTC to ${walletName}, but ord reports ${JSON.stringify(balance)}`,
    );
  }
  return addr;
}

/**
 * Pay `outputs` (address -> BTC amount string) from ONE `ordpool-e2e` coin
 * that stock ord reports as carrying no inscription, then mine a block and
 * wait for electrs and stock ord. The funder wallet also receives
 * inscriptions from other specs, and if Core's coin selection spent one of
 * those, the recipients would get an inscribed sat: an ord wallet then sees
 * its funding as ordinal and refuses it with "no cardinal utxos". Returns
 * the transaction id; output i pays the i-th entry of `outputs`.
 */
export async function sendFromCleanFunderCoin(outputs: Record<string, string>): Promise<string> {
  const wantSats = Object.values(outputs).reduce((sum, btc) => sum + Math.round(Number(btc) * 1e8), 0);
  await waitForOrdStockSync(Number(rpc('getblockcount')));
  const unspent = JSON.parse(rpc(RPC_WALLET_ARG, 'listunspent', '1')) as Array<{
    txid: string; vout: number; amount: number; spendable: boolean;
  }>;
  const candidates = unspent
    .filter(u => u.spendable && Math.round(u.amount * 1e8) > wantSats)
    .sort((a, b) => b.amount - a.amount);
  let input: { txid: string; vout: number } | undefined;
  for (const u of candidates) {
    if ((await getStockOrdOutputInscriptions(`${u.txid}:${u.vout}`)).length === 0) {
      input = { txid: u.txid, vout: u.vout };
      break;
    }
  }
  if (input === undefined) {
    throw new Error(`sendFromCleanFunderCoin: ordpool-e2e holds no confirmed inscription-free UTXO above ${wantSats} sats`);
  }
  // change_position after the payments keeps output i = the i-th payment.
  const sent = JSON.parse(rpc(
    RPC_WALLET_ARG, 'send',
    JSON.stringify(Object.entries(outputs).map(([address, btc]) => ({ [address]: btc }))), 'null', 'unset', 'null',
    JSON.stringify({ inputs: [input], add_inputs: false, change_position: Object.keys(outputs).length }),
  )) as { txid: string };

  const tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdStockSync(tip);
  return sent.txid;
}

// ---------------------------------------------------------------------------
// Watch-only (xpub) test account
// ---------------------------------------------------------------------------

/**
 * Regtest address parameters. Spelled out here because this file compiles into
 * `dist-e2e` under `rootDir: e2e` and so cannot import the SDK's own
 * `toScureNetwork`; the spec asserts the two agree address for address.
 */
const REGTEST_SCURE_NETWORK = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

/** BIP-32 version bytes for testnet/regtest extended keys (tpub / tprv). */
const WATCH_ONLY_TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };

/**
 * A taproot account whose PUBLIC half is pasted into a watch-only connect
 * field and whose PRIVATE half stands in for the offline signer.
 *
 * This is the one wallet in the matrix with no extension and no popup: the
 * consumer exports an UNSIGNED PSBT to a textarea, something off-device signs
 * it, and the signed PSBT is pasted back. A spec therefore needs both halves
 * of the same account, which is what this hands out.
 */
export interface WatchOnlyTestAccount {
  /** Paste this into the connect field. A `tpub` on regtest/testnet. */
  accountExtendedPublicKey: string;
  /** Receive address at `m/<account>/0/<index>`, p2tr. Fund and assert on these. */
  addressAt(index: number): string;
  /**
   * The full p2tr payment at that index, for building an input by hand.
   *
   * Use `script` as the witnessUtxo script and `tapInternalKey` as the input's
   * tapInternalKey. Do NOT take the key by decoding the address: an address
   * decodes to the TWEAKED output key, and an input carrying that as its
   * tapInternalKey cannot be signed (`@scure/btc-signer` reports
   * "No taproot scripts signed"). The SDK's own builders already set this
   * correctly, so a PSBT exported by a consumer needs none of this.
   */
  p2trAt(index: number): ReturnType<typeof btc.p2tr>;
  /**
   * Sign an exported unsigned PSBT the way an offline wallet would, and return
   * base64 for the paste field.
   *
   * `receiveIndexPerInput[i]` is the receive index whose key owns input `i`;
   * it defaults to index 0 for every input, which is the common single-input
   * mint / commit shape. Signing only, never finalising: the consumer's export
   * signer finalises and broadcasts, and that is the step under test.
   */
  signExportedPsbt(unsignedPsbtBase64: string, receiveIndexPerInput?: number[]): string;
}

/**
 * Build a deterministic watch-only account for a spec.
 *
 * Deterministic by a fixed seed rather than by a BIP-39 mnemonic: deriving
 * from words needs `@scure/bip39`, which the SDK does not depend on, and a
 * test helper is not worth a new dependency in a signing library. Nothing
 * here needs to match any particular wallet's onboarding seed. Pass `seed`
 * for an isolated account when a spec must not share addresses with another.
 *
 * The default account path is `m/86'/1'/7'`, deliberately NOT the `…/0'` that
 * wallet onboarding uses, so a funded address here cannot collide with one a
 * wallet spec funds from the same fixed seed.
 */
export function makeWatchOnlyTestAccount(
  options: { seed?: Uint8Array; accountPath?: string } = {},
): WatchOnlyTestAccount {
  const seed = options.seed ?? new Uint8Array(32).fill(0x2a);
  const accountPath = options.accountPath ?? "m/86'/1'/7'";
  const account = HDKey.fromMasterSeed(seed, WATCH_ONLY_TESTNET_VERSIONS).derive(accountPath);

  const p2trAt = (index: number): ReturnType<typeof btc.p2tr> => {
    const child = account.deriveChild(0).deriveChild(index);
    if (child.publicKey === null) {
      throw new Error(`makeWatchOnlyTestAccount: no public key at receive index ${index}`);
    }
    // x-only key: drop the compressed-form parity byte. This is the UNTWEAKED
    // internal key, which is what a taproot input must carry; the address
    // encodes the tweaked output key instead.
    return btc.p2tr(child.publicKey.slice(1, 33), undefined, REGTEST_SCURE_NETWORK, true);
  };

  const privateKeyAt = (index: number): Uint8Array => {
    const child = account.deriveChild(0).deriveChild(index);
    if (child.privateKey === null) {
      throw new Error(`makeWatchOnlyTestAccount: no private key at receive index ${index}`);
    }
    return child.privateKey;
  };

  return {
    accountExtendedPublicKey: account.publicExtendedKey,

    addressAt(index: number): string {
      const address = p2trAt(index).address;
      if (address === undefined) {
        throw new Error(`makeWatchOnlyTestAccount: p2tr gave no address at index ${index}`);
      }
      return address;
    },

    p2trAt,

    signExportedPsbt(unsignedPsbtBase64: string, receiveIndexPerInput?: number[]): string {
      const tx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbtBase64));
      for (let i = 0; i < tx.inputsLength; i++) {
        tx.signIdx(privateKeyAt(receiveIndexPerInput?.[i] ?? 0), i);
      }
      return base64.encode(tx.toPSBT());
    },
  };
}

// ---------------------------------------------------------------------------
// A listed cat: a real CAT-21 cat at an address a spec chooses
// ---------------------------------------------------------------------------

/** A real cat on chain, owned by the address the caller named. */
export interface SeededListedCat {
  txid: string;
  vout: number;
  /** The cat UTXO's real value. Offer and transfer must PRESERVE this. */
  value: number;
  /** The ordinals address holding it: the `O` a seller owns. */
  sellerOrdinalsAddress: string;
  /** cat21-ord's id for it, for a `waitForCatAtAddress` of your own. */
  inscriptionId: string;
  /**
   * The CAT NUMBER, as cat21-ord assigns it.
   *
   * Returned so a consumer driving a number-lookup page does not have to
   * discover it by reading `/cats` and assuming an ordering. Under
   * `--index-cat21` ord's inscription number IS the cat number, because the
   * index contains nothing else.
   */
  catNumber: number;
}

/**
 * Mint a real `nLockTime=21` cat to an address the CALLER chooses, and wait
 * until cat21-ord has indexed it there.
 *
 * For driving an offer page end to end. The point of choosing the owner is
 * that a seller's ORDINALS address `O` must be DISTINCT from the payment
 * address `P` a seller types in, so a spec can assert the page pays `P` and
 * never `O`. That is the 2026-07-18 regression: `make-offer` took
 * `resolvedSellerAddress` from an ord lookup, which returns the ordinals
 * address, and piped it in as the payment address, so every URL-driven accept
 * broke silently. A fixture that lets O and P coincide cannot catch it.
 *
 * `valueSats` defaults to 546, the mint postage. **Pass something else too.**
 * Offer and transfer PRESERVE the cat UTXO's value rather than normalising it,
 * so a 546-only test proves nothing about size handling, which is exactly how
 * an offer builder that hardcoded 546 stayed green until it was run at 9000.
 */
export async function seedListedCat(
  options: { ordinalsAddress: string; valueSats?: number },
): Promise<SeededListedCat> {
  const valueSats = options.valueSats ?? 546;
  const fundingSats = Math.max(1_000_000, valueSats * 4);

  // Throwaway key that owns only the funding coin, so the cat's provenance is
  // a plain mint and nothing else in the suite can spend it out from under us.
  const seed = randomBytes(32);
  const key = HDKey.fromMasterSeed(seed, WATCH_ONLY_TESTNET_VERSIONS);
  if (key.privateKey === null || key.publicKey === null) {
    throw new Error('seedListedCat: no key material');
  }
  const payment = btc.p2wpkh(key.publicKey, REGTEST_SCURE_NETWORK);
  const fundingAddress = payment.address;
  if (fundingAddress === undefined) throw new Error('seedListedCat: no funding address');

  rpc(RPC_WALLET_ARG, 'sendtoaddress', fundingAddress, (fundingSats / 1e8).toFixed(8));
  let tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  const funding = await waitForUtxoAt(fundingAddress, fundingSats);

  // lockTime 21 IS the mint: cat21-ord indexes any such output as a cat.
  // Sequence 0xfffffffe is the non-RBF value every third-party wallet gets,
  // so an accelerate UI can never replace a mint and drop the lockTime.
  const tx = new btc.Transaction({ lockTime: 21 });
  tx.addInput({
    txid: funding.txid,
    index: funding.vout,
    sequence: 0xfffffffe,
    witnessUtxo: { script: payment.script, amount: BigInt(funding.value) },
  });
  tx.addOutputAddress(options.ordinalsAddress, BigInt(valueSats), REGTEST_SCURE_NETWORK);
  const changeSats = funding.value - valueSats - 1_000;
  if (changeSats < 546) throw new Error(`seedListedCat: funding too small for ${valueSats} sats`);
  tx.addOutputAddress(fundingAddress, BigInt(changeSats), REGTEST_SCURE_NETWORK);
  tx.signIdx(key.privateKey, 0, [btc.SigHash.ALL]);
  tx.finalize();

  const txid = await postTx(tx.hex);
  tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForTxConfirmed(txid);
  await waitForOrdSync(tip);

  // cat21-ord is the authority that this is a cat AND that it sits at O.
  const inscriptionId = catInscriptionId(txid);
  const indexed = await waitForCatAtAddress(inscriptionId, options.ordinalsAddress);
  if (indexed.value !== valueSats) {
    throw new Error(`seedListedCat: ord reports ${indexed.value} sats, expected ${valueSats}`);
  }

  return {
    txid,
    vout: 0,
    value: indexed.value,
    sellerOrdinalsAddress: options.ordinalsAddress,
    inscriptionId,
    catNumber: indexed.number,
  };
}

/** An asset class a user destroys by spending the coin that carries it. */
export type DirtyCoinAsset = 'inscription' | 'cat' | 'rune' | 'rareSat';

/** A coin carrying a real, indexed asset, seeded where a guard spec needs it. */
export interface SeededDirtyCoin {
  asset: DirtyCoinAsset;
  /** `<txid>:<vout>`. The thing a guard spec asserts was NOT spent. */
  outpoint: string;
  txid: string;
  vout: number;
  /** The coin's value, equal to the `valueSats` asked for. */
  value: number;
  /** Where it sits, equal to the `address` asked for. */
  address: string;
  /**
   * What ord names when it refuses the coin: an inscription id, a cat's
   * inscription id, a rune name, or a sat number as a string.
   */
  assetId: string;
}

/**
 * Seed a coin carrying a real asset, at an address and a value the caller
 * chooses, confirmed and indexed by the time this returns.
 *
 * One entry point for all four classes so a guard spec is a loop rather than
 * four bespoke setups, and so the classes cannot drift apart in the shape they
 * hand back.
 *
 * ## Why `valueSats` is required
 *
 * Because a guard spec proves nothing unless the dirty coin is the coin an
 * UNGUARDED selection would actually have taken. Selection picks the SMALLEST
 * covering candidate, so the dirty coin belongs slightly above the funding
 * requirement with a clean coin well above it. Seed it too large and it is
 * never a candidate; the spec then passes with the guard deleted.
 *
 * A default would make that mistake silently, which is exactly how the
 * inscription case sat at 2 000 000 sats and proved nothing. Requiring the
 * argument forces the caller to answer the question.
 *
 * ## Three ways a guard spec proves nothing
 *
 * All three have been found in this family's suites, so check for them:
 *
 *  1. Every coin in the pool is clean, so the guard is never engaged.
 *  2. The dirty coin is too large to be a best-fit candidate.
 *  3. The dirty coin is the ONLY coin, so there is no alternative to steer to.
 *     That proves the guard FLAGS; it does not prove selection AVOIDS.
 *
 * The shape that proves something: a dirty coin just over the requirement, a
 * clean coin well over it, and an assertion that {@link SeededDirtyCoin.outpoint}
 * is absent from the spent outpoints afterwards. Then break the guard and watch
 * that assertion fail.
 *
 * ## Indexing
 *
 * Cats come from `cat21-ord` (`--index-cat21`); inscriptions, runes and rare
 * sats come from the full ord (`--index-runes` and `--index-sats`). A stack
 * whose full ord lacks those flags reports a dirty coin as clean, and a guard
 * spec against it is green for the wrong reason.
 */
export async function seedDirtyCoin(options: {
  asset: DirtyCoinAsset;
  address: string;
  valueSats: number;
}): Promise<SeededDirtyCoin> {
  const { asset, address, valueSats } = options;
  if (!Number.isInteger(valueSats) || valueSats < 546) {
    throw new Error(`seedDirtyCoin: valueSats must be a whole number of sats at or above the dust floor; got ${valueSats}`);
  }

  const seeded = await (async (): Promise<{ txid: string; vout: number; value: number; address: string; assetId: string }> => {
    switch (asset) {
      case 'inscription': {
        const c = await seedInscribedCoin({ address, valueSats });
        return { ...c, assetId: c.inscriptionId };
      }
      case 'cat': {
        // A real nLockTime=21 mint, so cat21-ord indexes it as a cat rather
        // than the coin merely looking like one.
        const c = await seedListedCat({ ordinalsAddress: address, valueSats });
        return { txid: c.txid, vout: c.vout, value: c.value, address: c.sellerOrdinalsAddress, assetId: c.inscriptionId };
      }
      case 'rune': {
        const c = await seedRuneCoin({ address, valueSats });
        return { ...c, assetId: c.runeName };
      }
      case 'rareSat': {
        // The notable sat sits at offset 0 of this coin, which is where a
        // rare-sat classifier reads it.
        const c = await seedRareSatCoin({ address, valueSats });
        return { ...c, assetId: String(c.sat) };
      }
    }
  })();

  // Postconditions, because every one of these failing silently turns a guard
  // spec green for the wrong reason.
  if (seeded.value !== valueSats) {
    throw new Error(`seedDirtyCoin(${asset}): got a ${seeded.value}-sat coin, not the ${valueSats} asked for`);
  }
  if (seeded.address !== address) {
    throw new Error(`seedDirtyCoin(${asset}): landed at ${seeded.address}, not the ${address} asked for`);
  }

  return {
    asset,
    outpoint: `${seeded.txid}:${seeded.vout}`,
    txid: seeded.txid,
    vout: seeded.vout,
    value: seeded.value,
    address: seeded.address,
    assetId: seeded.assetId,
  };
}
