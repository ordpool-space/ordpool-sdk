"use strict";
// Small helpers shared across regtest E2E specs. Hits the local
// bitcoind RPC + electrs HTTP API directly — no framework, no DI.
//
// Expects the regtest stack to be up via `e2e/regtest-bootstrap.sh`
// and `REGTEST_FUNDED_ADDR` / `REGTEST_FUNDED_WIF` set in env.
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
exports.ORD_STOCK_URL = void 0;
exports.getFundedAccount = getFundedAccount;
exports.rpc = rpc;
exports.mineBlocks = mineBlocks;
exports.mineBlockWithRawTxs = mineBlockWithRawTxs;
exports.waitForElectrsSync = waitForElectrsSync;
exports.waitForUtxoMatching = waitForUtxoMatching;
exports.waitForUtxoAt = waitForUtxoAt;
exports.waitForAddressTxIndexed = waitForAddressTxIndexed;
exports.getUtxos = getUtxos;
exports.getTxHex = getTxHex;
exports.fundCommonSats = fundCommonSats;
exports.postTx = postTx;
exports.getTxStatus = getTxStatus;
exports.waitForTxConfirmed = waitForTxConfirmed;
exports.getTx = getTx;
exports.catInscriptionId = catInscriptionId;
exports.waitForOrdReady = waitForOrdReady;
exports.waitForOrdSync = waitForOrdSync;
exports.getOrdInscription = getOrdInscription;
exports.waitForCatAtAddress = waitForCatAtAddress;
exports.ordCli = ordCli;
exports.ordCreateOffer = ordCreateOffer;
exports.ordWalletSend = ordWalletSend;
exports.waitForOrdWalletCardinal = waitForOrdWalletCardinal;
exports.ordCreateWallet = ordCreateWallet;
exports.writeCat21OrdFile = writeCat21OrdFile;
exports.ordWalletInscribe = ordWalletInscribe;
exports.assertCatLandsAtRecipient = assertCatLandsAtRecipient;
exports.assertAllInputsSighashAll = assertAllInputsSighashAll;
exports.inscriptionId = inscriptionId;
exports.waitForOrdStockReady = waitForOrdStockReady;
exports.waitForOrdStockSync = waitForOrdStockSync;
exports.getStockOrdInscription = getStockOrdInscription;
exports.getStockOrdOutputInscriptions = getStockOrdOutputInscriptions;
exports.seedRuneCoin = seedRuneCoin;
exports.seedInscribedCoin = seedInscribedCoin;
exports.seedRareSatCoin = seedRareSatCoin;
exports.getStockOrdSat = getStockOrdSat;
exports.getStockOrdOutput = getStockOrdOutput;
exports.ordStockWalletReceive = ordStockWalletReceive;
exports.ordStockWalletOutputs = ordStockWalletOutputs;
exports.fundUninscribed = fundUninscribed;
exports.getStockOrdContent = getStockOrdContent;
exports.waitForOrdStockInscription = waitForOrdStockInscription;
exports.ordStockCli = ordStockCli;
exports.ordStockCliAsync = ordStockCliAsync;
exports.ordStockCreateWallet = ordStockCreateWallet;
exports.writeOrdStockFile = writeOrdStockFile;
exports.ordStockWalletInscribe = ordStockWalletInscribe;
exports.ordStockWalletBatch = ordStockWalletBatch;
exports.fundOrdStockWallet = fundOrdStockWallet;
exports.sendFromCleanFunderCoin = sendFromCleanFunderCoin;
exports.makeWatchOnlyTestAccount = makeWatchOnlyTestAccount;
exports.seedListedCat = seedListedCat;
exports.seedDirtyCoin = seedDirtyCoin;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_util_1 = require("node:util");
const bip32_1 = require("@scure/bip32");
const base_1 = require("@scure/base");
const btc = __importStar(require("@scure/btc-signer"));
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const ELECTRS_URL = process.env.REGTEST_ELECTRS_URL ??
    `http://localhost:${process.env.E2E_ELECTRS_HOST_PORT ?? 3010}`;
const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';
// Stock ord (no --index-cat21 flag) — see docker-compose.regtest.yml,
// service `ord-stock`. Used by the `inscribe-ord-indexing-roundtrip`
// spec to verify a real upstream-ord recognises the SDK's inscriptions.
exports.ORD_STOCK_URL = process.env.REGTEST_ORD_STOCK_URL ?? 'http://localhost:8081';
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
function getFundedAccount() {
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
function rpc(...args) {
    return (0, node_child_process_1.execFileSync)('docker', ['exec', BITCOIND_CONTAINER, 'bitcoin-cli',
        '-regtest', '-rpcuser=ordpool', '-rpcpassword=ordpool', ...args], { encoding: 'utf8' }).trim();
}
/** Mine N blocks to a throwaway address. Returns the new tip height. */
function mineBlocks(n) {
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
function mineBlockWithRawTxs(rawTxHexes) {
    const address = rpc(RPC_WALLET_ARG, 'getnewaddress', '', 'legacy');
    rpc('generateblock', address, JSON.stringify(rawTxHexes));
    return Number(rpc('getblockcount'));
}
/** Wait until electrs has indexed up to (at least) the given height. */
async function waitForElectrsSync(targetHeight, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const tipText = await fetch(`${ELECTRS_URL}/blocks/tip/height`).then(r => r.text()).catch(() => '0');
        if (Number(tipText) >= targetHeight)
            return;
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
async function waitForUtxoMatching(address, predicate, description, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastUtxos = [];
    while (Date.now() < deadline) {
        lastUtxos = await getUtxos(address);
        const hit = lastUtxos.find(predicate);
        if (hit)
            return hit;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`UTXO matching "${description}" at ${address} didn't appear within ${timeoutMs}ms; got ${JSON.stringify(lastUtxos)}`);
}
/** Common case: poll for a UTXO of exactly `expectedSats`. */
async function waitForUtxoAt(address, expectedSats, timeoutMs = 15_000) {
    return waitForUtxoMatching(address, u => u.value === expectedSats, `value=${expectedSats}`, timeoutMs);
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
async function waitForAddressTxIndexed(address, expectedTxid, timeoutMs = 15_000) {
    await waitForUtxoMatching(address, u => u.txid === expectedTxid, `txid=${expectedTxid}`, timeoutMs);
}
async function getUtxos(address) {
    const res = await fetch(`${ELECTRS_URL}/address/${address}/utxo`);
    if (!res.ok)
        throw new Error(`utxo fetch failed: ${res.status} ${await res.text()}`);
    const utxos = (await res.json());
    // One entry per outpoint. Around the moment a transaction confirms, electrs
    // can list the SAME outpoint twice, once confirmed and once not, so a spec
    // that sums this list sees double. Observed on regtest 2026-09-12: two
    // identical `<txid>:0` entries of 500 000 sats for an address that had
    // received 500 000 once. Both copies describe the same output, so keeping
    // either is correct; counting both is not.
    const byOutpoint = new Map();
    for (const u of utxos) {
        const key = `${u.txid}:${u.vout}`;
        if (!byOutpoint.has(key))
            byOutpoint.set(key, u);
    }
    return [...byOutpoint.values()];
}
async function getTxHex(txid) {
    const res = await fetch(`${ELECTRS_URL}/tx/${txid}/hex`);
    if (!res.ok)
        throw new Error(`tx hex fetch failed: ${res.status} ${await res.text()}`);
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
async function fundCommonSats(paymentAddress, amountBtc) {
    const unspent = JSON.parse(rpc(RPC_WALLET_ARG, 'listunspent', '100'));
    const coin = [...unspent].sort((a, b) => b.amount - a.amount)[0];
    if (!coin)
        throw new Error('fundCommonSats: no mature coin to fund from');
    const raw = rpc('createrawtransaction', JSON.stringify([{ txid: coin.txid, vout: coin.vout }]), JSON.stringify([{ [paymentAddress]: amountBtc }]));
    const funded = JSON.parse(rpc(RPC_WALLET_ARG, 'fundrawtransaction', raw, JSON.stringify({ changePosition: 0 })));
    const signed = JSON.parse(rpc(RPC_WALLET_ARG, 'signrawtransactionwithwallet', funded.hex));
    rpc(RPC_WALLET_ARG, 'sendrawtransaction', signed.hex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForUtxoAt(paymentAddress, Math.round(amountBtc * 1e8));
    // Both ord instances must have indexed the funding block before any content
    // scan, or /output 404s -> scan-failed -> no auto-pick.
    await waitForOrdStockSync(tip);
    await waitForOrdSync(tip);
}
async function postTx(hexPayload) {
    const res = await fetch(`${ELECTRS_URL}/tx`, {
        method: 'POST',
        body: hexPayload,
    });
    const body = (await res.text()).trim();
    if (!res.ok)
        throw new Error(`broadcast failed (${res.status}): ${body}`);
    return body;
}
async function getTxStatus(txid) {
    const res = await fetch(`${ELECTRS_URL}/tx/${txid}/status`);
    if (!res.ok)
        throw new Error(`tx status fetch failed: ${res.status}`);
    return res.json();
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
async function waitForTxConfirmed(txid, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastSeen;
    while (Date.now() < deadline) {
        const tx = await getTx(txid).catch(() => undefined);
        if (tx) {
            lastSeen = tx;
            if (tx.status.confirmed && tx.status.block_hash)
                return tx;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`tx ${txid} not confirmed within ${timeoutMs}ms; ` +
        `last status: ${lastSeen ? JSON.stringify(lastSeen.status) : 'not-found'}`);
}
async function getTx(txid) {
    const res = await fetch(`${ELECTRS_URL}/tx/${txid}`);
    if (!res.ok)
        throw new Error(`tx fetch failed: ${res.status} ${await res.text()}`);
    return res.json();
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
function catInscriptionId(mintTxid) {
    return `${mintTxid}i0`;
}
/**
 * Poll ord's HTTP server until it answers `/status` with a 2xx — the
 * binary takes a moment to warm its index before binding. The compose
 * file has no healthcheck because the slim runtime image lacks wget/curl,
 * so the test bootstrap polls here.
 */
async function waitForOrdReady(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await fetch(`${ORD_URL}/status`).then(r => r.ok).catch(() => false);
        if (ok)
            return;
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
async function waitForOrdSync(targetHeight, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await fetch(`${ORD_URL}/status`, {
            headers: { Accept: 'application/json' },
        }).then(r => r.ok ? r.json() : null).catch(() => null);
        if (status && typeof status.height === 'number' && status.height >= targetHeight)
            return;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`ord didn't reach height ${targetHeight} within ${timeoutMs}ms`);
}
/**
 * Fetch a cat's inscription record from ord. Returns the owner address,
 * current UTXO, and other ord-side state. Throws on any non-2xx — the
 * caller passes through after asserting on shape.
 */
async function getOrdInscription(inscriptionId) {
    const res = await fetch(`${ORD_URL}/inscription/${inscriptionId}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`ord /inscription/${inscriptionId} returned ${res.status}: ${await res.text()}`);
    }
    return res.json();
}
/**
 * Wait until ord reports the cat at `inscriptionId` is owned by
 * `expectedAddress`. Polls every 300ms; throws on timeout with the
 * last-observed owner.
 *
 * Use this after each broadcast + confirm step in the multi-step spec
 * to assert the cat actually moved where the SDK said it would.
 */
async function waitForCatAtAddress(inscriptionId, expectedAddress, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastSeen;
    while (Date.now() < deadline) {
        const insc = await getOrdInscription(inscriptionId).catch(() => undefined);
        if (insc) {
            lastSeen = insc;
            if (insc.address === expectedAddress)
                return insc;
        }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`cat ${inscriptionId} not at ${expectedAddress} within ${timeoutMs}ms; ` +
        `last owner: ${lastSeen?.address ?? 'unknown'}`);
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
function ordCli(...args) {
    return (0, node_child_process_1.execFileSync)('docker', [
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
    ], { encoding: 'utf8' }).trim();
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
function ordWalletCli(walletName, ...subcommandArgs) {
    return ordCli('wallet', '--no-sync', '--name', walletName, '--server-url', 'http://localhost:8080', ...subcommandArgs);
}
function ordCreateOffer(inscriptionId, amountSats, feeRateSatPerVb, wallet = 'ord') {
    const stdout = ordWalletCli(wallet, 'offer', 'create', '--inscription', inscriptionId, '--amount', `${amountSats}sat`, '--fee-rate', String(feeRateSatPerVb));
    return JSON.parse(stdout);
}
/**
 * Reference `ord wallet send` (the stock transfer). `--dry-run` returns the
 * constructed PSBT without broadcasting, for byte-comparison against the SDK's
 * transfer. `postageSats` maps to ord's `--postage` (default 10000 when
 * omitted). The wallet must OWN the inscription being sent.
 */
function ordWalletSend(recipientAddress, inscriptionId, feeRateSatPerVb, postageSats, wallet = 'ord') {
    const args = ['send', '--dry-run', '--fee-rate', String(feeRateSatPerVb)];
    if (postageSats !== undefined)
        args.push('--postage', `${postageSats}sat`);
    args.push(recipientAddress, inscriptionId);
    return JSON.parse(ordWalletCli(wallet, ...args));
}
/**
 * Block until ord's OWN wallet view shows a spendable cardinal of at least
 * `minSats`.
 *
 * `ordWalletCli` passes `--no-sync`, so every wallet subcommand reads whatever
 * ord has already indexed rather than asking the node. Waiting for electrs, or
 * even for ord's index tip, therefore does NOT establish that ord's WALLET can
 * see a freshly mined funding output: those are three different views and a
 * spec depends on the third. Waiting on the wrong one produces "wallet does not
 * contain enough cardinal UTXOs" intermittently, on a chain where the coin
 * demonstrably exists.
 *
 * Polls through the same `--no-sync` path the later command uses, so what this
 * observes is exactly what that command will see.
 */
async function waitForOrdWalletCardinal(walletName, minSats, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = '<never read>';
    while (Date.now() < deadline) {
        try {
            const outputs = JSON.parse(ordWalletCli(walletName, 'outputs'));
            lastSeen = outputs.map(o => `${o.output}=${o.amount}${o.inscriptions?.length ? ' (inscribed)' : ''}`).join(', ') || '<empty>';
            const cardinal = outputs.find(o => o.amount >= minSats && !(o.inscriptions && o.inscriptions.length));
            if (cardinal)
                return;
        }
        catch (e) {
            lastSeen = `<outputs failed: ${e.message.split('\n')[0]}>`;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`ord wallet "${walletName}" never showed a cardinal of >= ${minSats} sats within ${timeoutMs}ms. ` +
        `Its --no-sync view held: ${lastSeen}`);
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
function ordCliErrorSays(e, ...needles) {
    const err = e;
    const text = [err.message, err.stderr, err.stdout]
        .map(part => (part == null ? '' : String(part)))
        .join('\n');
    return needles.some(n => text.includes(n));
}
function ordCreateWallet(name = 'ord') {
    // ord's `wallet create` is idempotent only on the wallet's existence;
    // we ignore the "wallet already exists" error path so the helper can
    // be called from a clean spec setup or a re-run.
    try {
        ordWalletCli(name, 'create');
    }
    catch (e) {
        // The child's own text lands on `stderr`; `message` is a generic
        // non-zero-exit string. Matching only `message` re-throws on a wallet that
        // already exists, so this stops being idempotent across local re-runs. CI
        // never sees it, because its stack is always fresh.
        if (!ordCliErrorSays(e, 'already exists', 'already loaded'))
            throw e;
    }
    const stdout = ordWalletCli(name, 'receive');
    const parsed = JSON.parse(stdout);
    if (parsed.address)
        return parsed.address;
    if (parsed.addresses && parsed.addresses.length > 0)
        return parsed.addresses[0];
    throw new Error(`unexpected ord wallet receive shape: ${stdout}`);
}
/**
 * Write arbitrary bytes to a file inside the cat21-ord container (via
 * base64 to survive any byte value / the shell). Used to feed `ord wallet
 * inscribe --file` a known content for byte-parity comparison.
 */
function writeCat21OrdFile(containerPath, content) {
    const b64 = Buffer.from(content).toString('base64');
    (0, node_child_process_1.execFileSync)('docker', ['exec', 'ordpool-e2e-cat21-ord', 'sh', '-c', `printf %s '${b64}' | base64 -d > '${containerPath}'`], { encoding: 'utf8' });
}
/**
 * Run ord's OWN `wallet inscribe` (the reference implementation). Returns
 * the commit + reveal txids. `--no-backup` avoids ord's recovery-key
 * import into bitcoind (which fails on the shared regtest wallet). The
 * envelope-construction code (`append_reveal_script`) is identical to
 * stock ord, so the reveal's envelope bytes are ord-canonical.
 */
function ordWalletInscribe(walletName, containerFilePath, feeRateSatPerVb, extraArgs = []) {
    const stdout = ordWalletCli(walletName, 'inscribe', '--no-backup', '--fee-rate', String(feeRateSatPerVb), '--file', containerFilePath, ...extraArgs);
    const parsed = JSON.parse(stdout);
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
function assertCatLandsAtRecipient(tx, recipientAddress, expectedPostageSats = 546) {
    const vout0 = tx.vout[0];
    if (vout0?.scriptpubkey_address !== recipientAddress) {
        throw new Error(`Cat did NOT land at the recipient: vout[0] pays ${vout0?.scriptpubkey_address ?? '(none)'}, ` +
            `expected ${recipientAddress}`);
    }
    if (vout0.value !== expectedPostageSats) {
        throw new Error(`Cat output has wrong postage: vout[0].value = ${vout0.value}, expected ${expectedPostageSats}`);
    }
}
function assertAllInputsSighashAll(tx) {
    for (let i = 0; i < tx.vin.length; i++) {
        const input = tx.vin[i];
        if (input.is_coinbase)
            continue;
        const witness = input.witness ?? [];
        if (witness.length > 0) {
            const sigHex = witness[0];
            const isTaproot = input.prevout?.scriptpubkey_type === 'v1_p2tr';
            if (isTaproot) {
                if (sigHex.length === 128)
                    continue;
                if (sigHex.length === 130) {
                    const flag = sigHex.slice(-2);
                    if (flag === '01')
                        continue;
                    throw new Error(`Input ${i}: Taproot sighash flag 0x${flag} (expected 0x01 = SIGHASH_ALL)`);
                }
                throw new Error(`Input ${i}: Taproot sig wrong length ${sigHex.length / 2} bytes (expected 64 or 65)`);
            }
            const flag = sigHex.slice(-2);
            if (flag !== '01')
                throw new Error(`Input ${i}: SegWit sighash flag 0x${flag} (expected 0x01 = SIGHASH_ALL)`);
        }
        else if (input.scriptsig) {
            const ss = input.scriptsig;
            const pushLen = parseInt(ss.slice(0, 2), 16);
            const sigEnd = (1 + pushLen) * 2;
            const sigHex = ss.slice(2, sigEnd);
            const flag = sigHex.slice(-2);
            if (flag !== '01')
                throw new Error(`Input ${i}: Legacy sighash flag 0x${flag} (expected 0x01 = SIGHASH_ALL)`);
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
function inscriptionId(txid, index = 0) {
    return `${txid}i${index}`;
}
/**
 * Poll stock ord's HTTP server until it answers `/status` with a
 * 2xx. Same warm-up rationale as `waitForOrdReady`.
 */
async function waitForOrdStockReady(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await fetch(`${exports.ORD_STOCK_URL}/status`).then(r => r.ok).catch(() => false);
        if (ok)
            return;
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`stock ord didn't respond on /status within ${timeoutMs}ms (is the ord-stock profile up?)`);
}
/**
 * Block until stock ord has indexed up to (at least) `targetHeight`.
 * ord's indexer lags bitcoind by a few hundred ms; without this gate
 * the inscription-lookup assertions race the indexer.
 */
async function waitForOrdStockSync(targetHeight, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await fetch(`${exports.ORD_STOCK_URL}/status`, {
            headers: { Accept: 'application/json' },
        }).then(r => r.ok ? r.json() : null).catch(() => null);
        if (status && typeof status.height === 'number' && status.height >= targetHeight)
            return;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`stock ord didn't reach height ${targetHeight} within ${timeoutMs}ms`);
}
/**
 * Fetch an inscription record from stock ord. Throws on any non-2xx;
 * callers wrap in `waitForOrdStockInscription` if they need to poll.
 */
async function getStockOrdInscription(id) {
    const res = await fetch(`${exports.ORD_STOCK_URL}/inscription/${id}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`stock ord /inscription/${id} returned ${res.status}: ${await res.text()}`);
    }
    return res.json();
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
async function getStockOrdOutputInscriptions(outpoint) {
    const res = await fetch(`${exports.ORD_STOCK_URL}/output/${outpoint}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`stock ord /output/${outpoint} returned ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json());
    return body.inscriptions ?? [];
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
async function seedRuneCoin(options = {}) {
    const runeName = options.runeName ?? uniqueRuneName();
    const walletName = options.walletName ?? 'rune-etcher';
    const feeRate = options.feeRate ?? 2;
    ordStockCreateWallet(walletName);
    const ordAddress = JSON.parse(ordStockWalletCli(walletName, 'receive'));
    const fundTo = ordAddress.address ?? ordAddress.addresses?.[0];
    if (!fundTo)
        throw new Error('seedRuneCoin: ord wallet gave no receive address');
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
            try {
                mineBlocks(1);
            }
            catch { /* the etch may already be done */ }
            await new Promise((r) => setTimeout(r, 6_000));
        }
    })();
    let result;
    try {
        result = JSON.parse(await ordStockWalletCliAsync(walletName, 'batch', '--fee-rate', String(feeRate), '--no-backup', '--batch', '/tmp/rune-batch.yaml'));
    }
    finally {
        mining = false;
        await miner;
    }
    const location = result.rune?.location;
    if (!location)
        throw new Error(`seedRuneCoin: ord reported no rune location: ${JSON.stringify(result)}`);
    const [txid, voutText] = location.split(':');
    const vout = Number(voutText);
    const tip = mineBlocks(2);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);
    const output = await getStockOrdOutput(`${txid}:${vout}`);
    const entry = output.runes?.[runeName];
    if (!entry) {
        throw new Error(`seedRuneCoin: stock ord reports no rune on ${txid}:${vout} (${JSON.stringify(output.runes)}). ` +
            'Is --index-runes on? Without it /output.runes is always null and no rune spec can prove anything.');
    }
    const etching = await fetch(`${exports.ORD_STOCK_URL}/rune/${encodeURIComponent(runeName)}`, {
        headers: { Accept: 'application/json' },
    }).then((r) => r.json());
    let seeded = { txid, vout, value: output.value, address: output.address };
    if (options.address !== undefined) {
        // The funding scan reads the PAYMENT address, so a rune left at ord's own
        // address is a coin the scan never sees.
        const sendArgs = ['send', '--fee-rate', String(feeRate)];
        if (options.valueSats !== undefined)
            sendArgs.push('--postage', `${options.valueSats}sat`);
        sendArgs.push(options.address, `1000:${runeName}`);
        const sent = ordStockWalletCli(walletName, ...sendArgs);
        const sentTxid = JSON.parse(sent).txid;
        const sentTip = mineBlocks(1);
        await waitForElectrsSync(sentTip);
        await waitForOrdStockSync(sentTip);
        const moved = await findRuneOutput(sentTxid, runeName, options.address);
        if (options.valueSats !== undefined && moved.value !== options.valueSats) {
            throw new Error(`seedRuneCoin: the rune landed on a ${moved.value}-sat coin, not the ${options.valueSats} asked for. ` +
                'A guard spec positions this coin by value, so a different one silently changes what is proven.');
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
async function findRuneOutput(txid, runeName, address) {
    const raw = JSON.parse(rpc('getrawtransaction', txid, 'true'));
    const seen = [];
    for (let vout = 0; vout < raw.vout.length; vout++) {
        const output = await getStockOrdOutput(`${txid}:${vout}`);
        if (!output.runes?.[runeName])
            continue;
        seen.push(`${vout}@${output.address}`);
        if (output.address === address)
            return { vout, value: output.value, address: output.address };
    }
    throw new Error(`findRuneOutput: no output of ${txid} carries ${runeName} at ${address}. ` +
        `Outputs holding the rune: ${seen.length ? seen.join(', ') : 'none'}.`);
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
function uniqueRuneName() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let n = Date.now();
    let suffix = '';
    while (suffix.length < 8) {
        suffix = alphabet[n % 26] + suffix;
        n = Math.floor(n / 26);
    }
    return `ORDPOOL\u2022${suffix}`;
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
async function seedInscribedCoin(options) {
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
        throw new Error(`seedInscribedCoin: stock ord does not report ${inscriptionId} on ${outpoint}; ` +
            `it reports ${JSON.stringify(output.inscriptions)}. The coin would not exercise the guard.`);
    }
    if (output.value !== postageSats) {
        throw new Error(`seedInscribedCoin: ${outpoint} holds ${output.value} sats, not the ${postageSats} asked for. ` +
            'A guard spec positions this coin by value, so a different one silently changes what is proven.');
    }
    return { txid: reveal, vout: 0, value: output.value, inscriptionId, address: output.address };
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
async function seedRareSatCoin(options = {}) {
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
    const unspent = JSON.parse(rpc(RPC_WALLET_ARG, 'listunspent', '100'));
    const byValue = [...unspent].sort((a, b) => b.amount - a.amount);
    let coinbase;
    for (const candidate of byValue) {
        if (candidate.vout !== 0)
            continue; // a coinbase pays its subsidy to vout 0
        const tx = JSON.parse(rpc('getrawtransaction', candidate.txid, '1'));
        if (tx.vin[0]?.coinbase !== undefined) {
            coinbase = candidate;
            break;
        }
    }
    if (!coinbase) {
        throw new Error('seedRareSatCoin: no unspent mature COINBASE output to seed from. ' +
            'Mine more blocks, or the chain has had its block-first sats spent.');
    }
    const raw = rpc('createrawtransaction', JSON.stringify([{ txid: coinbase.txid, vout: coinbase.vout }]), JSON.stringify([{ [address]: Number((valueSats / 1e8).toFixed(8)) }]));
    // changePosition 1 keeps the payment at vout 0, so it inherits the input's
    // first sats. Change after it takes the rest.
    const funded = JSON.parse(rpc(RPC_WALLET_ARG, 'fundrawtransaction', raw, JSON.stringify({ changePosition: 1 })));
    const signed = JSON.parse(rpc(RPC_WALLET_ARG, 'signrawtransactionwithwallet', funded.hex));
    const txid = rpc('sendrawtransaction', signed.hex).trim();
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);
    const output = await getStockOrdOutput(`${txid}:0`);
    const sat = output.sat_ranges[0][0];
    const { rarity } = await getStockOrdSat(sat);
    if (rarity === 'common') {
        throw new Error(`seedRareSatCoin: the seeded coin's first sat ${sat} is common, not notable. ` +
            'The chosen input was not a coinbase, or its first sats were already spent.');
    }
    if (output.value !== valueSats) {
        throw new Error(`seedRareSatCoin: ${txid}:0 holds ${output.value} sats, not the ${valueSats} asked for. ` +
            'A guard spec positions this coin by value, so a different one silently changes what is proven.');
    }
    return { txid, vout: 0, value: output.value, sat, rarity, address: output.address };
}
/** ord's own verdict on a sat: `GET /sat/<sat>`, which carries its rarity. */
async function getStockOrdSat(sat) {
    const res = await fetch(`${exports.ORD_STOCK_URL}/sat/${sat}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`stock ord /sat/${sat} returned ${res.status}: ${await res.text()}`);
    }
    return (await res.json());
}
async function getStockOrdOutput(outpoint) {
    const res = await fetch(`${exports.ORD_STOCK_URL}/output/${outpoint}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`stock ord /output/${outpoint} returned ${res.status}: ${await res.text()}`);
    }
    return res.json();
}
/** A fresh receive address of an ord-stock wallet (`ord wallet receive`). */
function ordStockWalletReceive(walletName) {
    const parsed = JSON.parse(ordStockWalletCli(walletName, 'receive'));
    const address = parsed.address ?? parsed.addresses?.[0];
    if (address === undefined)
        throw new Error(`unexpected ord wallet receive shape for ${walletName}`);
    return address;
}
/** `ord wallet outputs` in the ord-stock container. */
function ordStockWalletOutputs(walletName) {
    return JSON.parse(ordStockWalletCli(walletName, 'outputs'));
}
/**
 * A fresh 1 BTC P2WPKH UTXO in the `ordpool-e2e` wallet whose first sat
 * carries no inscription, for building SDK inscriptions that stock ord must
 * index as blessed. Inscribing onto an already-inscribed sat is a
 * reinscription, and the pool can hand one out (see
 * {@link getStockOrdOutputInscriptions}), so this re-funds until it gets a
 * clean one. Sign the SDK commit with `walletprocesspsbt` on `ordpool-e2e`.
 */
async function fundUninscribed() {
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
async function getStockOrdContent(id) {
    const res = await fetch(`${exports.ORD_STOCK_URL}/content/${id}`);
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
async function waitForOrdStockInscription(id, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await getStockOrdInscription(id);
        }
        catch (e) {
            lastError = e;
        }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`stock ord did not surface inscription ${id} within ${timeoutMs}ms; ` +
        `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
function ordStockCliArgs(args) {
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
function ordStockCli(...args) {
    return (0, node_child_process_1.execFileSync)('docker', ordStockCliArgs(args), { encoding: 'utf8' }).trim();
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
async function ordStockCliAsync(...args) {
    const { stdout } = await execFileAsync('docker', ordStockCliArgs(args), {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
}
/** The wallet-subcommand argv shared by the sync and async forms. */
function ordStockWalletArgs(walletName, subcommandArgs) {
    return [
        'wallet',
        '--no-sync',
        '--name', walletName,
        '--server-url', 'http://localhost:8080',
        ...subcommandArgs,
    ];
}
function ordStockWalletCli(walletName, ...subcommandArgs) {
    return ordStockCli(...ordStockWalletArgs(walletName, subcommandArgs));
}
/** Non-blocking `ord wallet …`, for commands that need blocks mined while they run. */
function ordStockWalletCliAsync(walletName, ...subcommandArgs) {
    return ordStockCliAsync(...ordStockWalletArgs(walletName, subcommandArgs));
}
function ordStockCreateWallet(name) {
    try {
        ordStockWalletCli(name, 'create');
    }
    catch (e) {
        // The child's own text lands on `stderr`; `message` is a generic
        // non-zero-exit string. Matching only `message` re-throws on a wallet that
        // already exists, so this stops being idempotent across local re-runs. CI
        // never sees it, because its stack is always fresh.
        if (!ordCliErrorSays(e, 'already exists', 'already loaded'))
            throw e;
    }
    const stdout = ordStockWalletCli(name, 'receive');
    const parsed = JSON.parse(stdout);
    if (parsed.address)
        return parsed.address;
    if (parsed.addresses && parsed.addresses.length > 0)
        return parsed.addresses[0];
    throw new Error(`unexpected ord wallet receive shape: ${stdout}`);
}
/**
 * Write `content` to `containerPath` inside the ord-stock container. The
 * bytes go over stdin, so any size works (an argv string is capped by the
 * OS's argument-length limit).
 */
function writeOrdStockFile(containerPath, content) {
    (0, node_child_process_1.execFileSync)('docker', ['exec', '-i', ORD_STOCK_CONTAINER, 'sh', '-c', `cat > '${containerPath}'`], { input: content });
}
function ordStockWalletInscribe(walletName, containerFilePath, feeRateSatPerVb, extraArgs = []) {
    const stdout = ordStockWalletCli(walletName, 'inscribe', '--no-backup', '--fee-rate', String(feeRateSatPerVb), '--file', containerFilePath, ...extraArgs);
    const parsed = JSON.parse(stdout);
    return { commit: parsed.commit, reveal: parsed.reveal };
}
/**
 * `ord wallet batch --fee-rate <R> --batch <FILE>` in the ord-stock
 * container. `batchYaml` is the batchfile's text; file paths inside it are
 * container paths (write them with {@link writeOrdStockFile} first).
 */
function ordStockWalletBatch(walletName, batchYaml, feeRateSatPerVb) {
    const path = `/tmp/batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.yaml`;
    writeOrdStockFile(path, new TextEncoder().encode(batchYaml));
    const stdout = ordStockWalletCli(walletName, 'batch', '--no-backup', '--fee-rate', String(feeRateSatPerVb), '--batch', path);
    return JSON.parse(stdout);
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
async function fundOrdStockWallet(walletName, btc = '2.0') {
    const addr = ordStockCreateWallet(walletName);
    const wantSats = Math.round(Number(btc) * 1e8);
    await sendFromCleanFunderCoin({ [addr]: btc });
    const balance = JSON.parse(ordStockWalletCli(walletName, 'balance'));
    if ((balance.cardinal ?? 0) < wantSats) {
        throw new Error(`fundOrdStockWallet: sent ${btc} BTC to ${walletName}, but ord reports ${JSON.stringify(balance)}`);
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
async function sendFromCleanFunderCoin(outputs) {
    const wantSats = Object.values(outputs).reduce((sum, btc) => sum + Math.round(Number(btc) * 1e8), 0);
    await waitForOrdStockSync(Number(rpc('getblockcount')));
    const unspent = JSON.parse(rpc(RPC_WALLET_ARG, 'listunspent', '1'));
    const candidates = unspent
        .filter(u => u.spendable && Math.round(u.amount * 1e8) > wantSats)
        .sort((a, b) => b.amount - a.amount);
    let input;
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
    const sent = JSON.parse(rpc(RPC_WALLET_ARG, 'send', JSON.stringify(Object.entries(outputs).map(([address, btc]) => ({ [address]: btc }))), 'null', 'unset', 'null', JSON.stringify({ inputs: [input], add_inputs: false, change_position: Object.keys(outputs).length })));
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
function makeWatchOnlyTestAccount(options = {}) {
    const seed = options.seed ?? new Uint8Array(32).fill(0x2a);
    const accountPath = options.accountPath ?? "m/86'/1'/7'";
    const account = bip32_1.HDKey.fromMasterSeed(seed, WATCH_ONLY_TESTNET_VERSIONS).derive(accountPath);
    const p2trAt = (index) => {
        const child = account.deriveChild(0).deriveChild(index);
        if (child.publicKey === null) {
            throw new Error(`makeWatchOnlyTestAccount: no public key at receive index ${index}`);
        }
        // x-only key: drop the compressed-form parity byte. This is the UNTWEAKED
        // internal key, which is what a taproot input must carry; the address
        // encodes the tweaked output key instead.
        return btc.p2tr(child.publicKey.slice(1, 33), undefined, REGTEST_SCURE_NETWORK, true);
    };
    const privateKeyAt = (index) => {
        const child = account.deriveChild(0).deriveChild(index);
        if (child.privateKey === null) {
            throw new Error(`makeWatchOnlyTestAccount: no private key at receive index ${index}`);
        }
        return child.privateKey;
    };
    return {
        accountExtendedPublicKey: account.publicExtendedKey,
        addressAt(index) {
            const address = p2trAt(index).address;
            if (address === undefined) {
                throw new Error(`makeWatchOnlyTestAccount: p2tr gave no address at index ${index}`);
            }
            return address;
        },
        p2trAt,
        signExportedPsbt(unsignedPsbtBase64, receiveIndexPerInput) {
            const tx = btc.Transaction.fromPSBT(base_1.base64.decode(unsignedPsbtBase64));
            for (let i = 0; i < tx.inputsLength; i++) {
                tx.signIdx(privateKeyAt(receiveIndexPerInput?.[i] ?? 0), i);
            }
            return base_1.base64.encode(tx.toPSBT());
        },
    };
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
async function seedListedCat(options) {
    const valueSats = options.valueSats ?? 546;
    const fundingSats = Math.max(1_000_000, valueSats * 4);
    // Throwaway key that owns only the funding coin, so the cat's provenance is
    // a plain mint and nothing else in the suite can spend it out from under us.
    const seed = (0, node_crypto_1.randomBytes)(32);
    const key = bip32_1.HDKey.fromMasterSeed(seed, WATCH_ONLY_TESTNET_VERSIONS);
    if (key.privateKey === null || key.publicKey === null) {
        throw new Error('seedListedCat: no key material');
    }
    const payment = btc.p2wpkh(key.publicKey, REGTEST_SCURE_NETWORK);
    const fundingAddress = payment.address;
    if (fundingAddress === undefined)
        throw new Error('seedListedCat: no funding address');
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
    if (changeSats < 546)
        throw new Error(`seedListedCat: funding too small for ${valueSats} sats`);
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
async function seedDirtyCoin(options) {
    const { asset, address, valueSats } = options;
    if (!Number.isInteger(valueSats) || valueSats < 546) {
        throw new Error(`seedDirtyCoin: valueSats must be a whole number of sats at or above the dust floor; got ${valueSats}`);
    }
    const seeded = await (async () => {
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
//# sourceMappingURL=regtest-helpers.js.map