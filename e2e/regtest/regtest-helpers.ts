// Small helpers shared across regtest E2E specs. Hits the local
// bitcoind RPC + electrs HTTP API directly — no framework, no DI.
//
// Expects the regtest stack to be up via `e2e/regtest-bootstrap.sh`
// and `REGTEST_FUNDED_ADDR` / `REGTEST_FUNDED_WIF` set in env.

import { execFileSync } from 'node:child_process';

const ELECTRS_URL = process.env.REGTEST_ELECTRS_URL ?? 'http://localhost:3000';
const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';
// Stock ord (no --index-cat21 flag) — see docker-compose.regtest.yml,
// service `ord-stock`. Used by the `inscribe-ord-indexing-roundtrip`
// spec to verify a real upstream-ord recognises the SDK's inscriptions.
const ORD_STOCK_URL = process.env.REGTEST_ORD_STOCK_URL ?? 'http://localhost:8081';
// The bitcoind container name. Defaults to the SDK's own stack
// (`ordpool-e2e-bitcoind`); consumer repos (cubes-frontend, ordpool)
// stand up their own compose with a different name (e.g.
// `ordpool-e2e-consumer-bitcoind`) and override via env.
const BITCOIND_CONTAINER = process.env.REGTEST_BITCOIND_CONTAINER ?? 'ordpool-e2e-bitcoind';

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
  const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'legacy');
  rpc('-rpcwallet=ordpool-e2e', 'generatetoaddress', String(n), address);
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
  const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'legacy');
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
