import * as btc from '@scure/btc-signer';
export declare const ORD_STOCK_URL: string;
export interface FundedAccount {
    address: string;
    wif: string;
}
export declare function getFundedAccount(): FundedAccount;
/** Run a bitcoin-cli command inside the bitcoind container. */
/**
 * Pipe a `bitcoin-cli` command into the regtest container. Args go
 * through execFileSync (no shell), so JSON payloads with braces and
 * colons don't need extra escaping.
 */
export declare function rpc(...args: string[]): string;
/** Mine N blocks to a throwaway address. Returns the new tip height. */
export declare function mineBlocks(n: number): number;
/**
 * Mine a block that INCLUDES the given raw transactions, bypassing mempool
 * relay policy (the `generateblock` RPC). This is how a transaction relay
 * would reject — e.g. one carrying a sub-dust output — reaches the chain
 * out-of-band, exactly as a direct-to-miner submission (Slipstream / MARA)
 * would. Returns the new tip height.
 */
export declare function mineBlockWithRawTxs(rawTxHexes: string[]): number;
/** Wait until electrs has indexed up to (at least) the given height. */
export declare function waitForElectrsSync(targetHeight: number, timeoutMs?: number): Promise<void>;
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
export declare function waitForUtxoMatching(address: string, predicate: (u: ElectrsUtxo) => boolean, description: string, timeoutMs?: number): Promise<ElectrsUtxo>;
/** Common case: poll for a UTXO of exactly `expectedSats`. */
export declare function waitForUtxoAt(address: string, expectedSats: number, timeoutMs?: number): Promise<ElectrsUtxo>;
/**
 * Wait until electrs's address-history index lists `expectedTxid`
 * against `address` (in either the spending or receiving slot).
 * Use this when you need to assert on the SAME tx from multiple
 * addresses' perspectives (e.g. confirm a redirect inscription
 * landed at B and NOT at A) — once the recipient sees the txid,
 * the sender's view is reliably up-to-date from the same
 * electrs.
 */
export declare function waitForAddressTxIndexed(address: string, expectedTxid: string, timeoutMs?: number): Promise<void>;
export interface ElectrsUtxo {
    txid: string;
    vout: number;
    value: number;
    status: {
        confirmed: boolean;
        block_height?: number;
        block_hash?: string;
        block_time?: number;
    };
}
export declare function getUtxos(address: string): Promise<ElectrsUtxo[]>;
export declare function getTxHex(txid: string): Promise<string>;
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
export declare function fundCommonSats(paymentAddress: string, amountBtc: number): Promise<void>;
export declare function postTx(hexPayload: string): Promise<string>;
export declare function getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
}>;
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
    status: {
        confirmed: boolean;
        block_height?: number;
        block_hash?: string;
        block_time?: number;
    };
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
export declare function waitForTxConfirmed(txid: string, timeoutMs?: number): Promise<EsploraTx>;
export declare function getTx(txid: string): Promise<EsploraTx>;
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
/** Build a cat21 inscription id from its minting txid. */
export declare function catInscriptionId(mintTxid: string): string;
/**
 * Poll ord's HTTP server until it answers `/status` with a 2xx — the
 * binary takes a moment to warm its index before binding. The compose
 * file has no healthcheck because the slim runtime image lacks wget/curl,
 * so the test bootstrap polls here.
 */
export declare function waitForOrdReady(timeoutMs?: number): Promise<void>;
/**
 * Block until ord has indexed up to (at least) `targetHeight`. ord's
 * indexer is one step behind electrs/bitcoind — it sees the new block
 * via ZMQ or polling and runs its CAT-21 filter on every tx. Without
 * this gate the cat-state assertions race the indexer.
 */
export declare function waitForOrdSync(targetHeight: number, timeoutMs?: number): Promise<void>;
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
export declare function getOrdInscription(inscriptionId: string): Promise<OrdInscription>;
/**
 * Wait until ord reports the cat at `inscriptionId` is owned by
 * `expectedAddress`. Polls every 300ms; throws on timeout with the
 * last-observed owner.
 *
 * Use this after each broadcast + confirm step in the multi-step spec
 * to assert the cat actually moved where the SDK said it would.
 */
export declare function waitForCatAtAddress(inscriptionId: string, expectedAddress: string, timeoutMs?: number): Promise<OrdInscription>;
/**
 * Invoke ord's CLI inside the regtest container. Returns stdout
 * trimmed. Errors bubble up via execFileSync's non-zero-exit throw.
 *
 * The container's `command:` runs `ord ... server ...`; this helper
 * spawns a SECOND ord process via `docker exec` for one-shot wallet
 * commands. Both processes read the same regtest bitcoind + index dir,
 * so wallet operations are immediately visible to the running server.
 */
export declare function ordCli(...args: string[]): string;
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
    psbt: string;
    inscription: string;
    seller_address: string;
}
export declare function ordCreateOffer(inscriptionId: string, amountSats: number, feeRateSatPerVb: number, wallet?: string): OrdOfferCreateOutput;
export interface OrdSendOutput {
    txid: string;
    psbt: string;
    fee: number;
}
/**
 * Reference `ord wallet send` (the stock transfer). `--dry-run` returns the
 * constructed PSBT without broadcasting, for byte-comparison against the SDK's
 * transfer. `postageSats` maps to ord's `--postage` (default 10000 when
 * omitted). The wallet must OWN the inscription being sent.
 */
export declare function ordWalletSend(recipientAddress: string, inscriptionId: string, feeRateSatPerVb: number, postageSats?: number, wallet?: string): OrdSendOutput;
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
export declare function waitForOrdWalletCardinal(walletName: string, minSats: number, timeoutMs?: number): Promise<void>;
export interface OrdAddressResponse {
    address: string;
}
export declare function ordCreateWallet(name?: string): string;
/**
 * Write arbitrary bytes to a file inside the cat21-ord container (via
 * base64 to survive any byte value / the shell). Used to feed `ord wallet
 * inscribe --file` a known content for byte-parity comparison.
 */
export declare function writeCat21OrdFile(containerPath: string, content: Uint8Array): void;
/**
 * Run ord's OWN `wallet inscribe` (the reference implementation). Returns
 * the commit + reveal txids. `--no-backup` avoids ord's recovery-key
 * import into bitcoind (which fails on the shared regtest wallet). The
 * envelope-construction code (`append_reveal_script`) is identical to
 * stock ord, so the reveal's envelope bytes are ord-canonical.
 */
export declare function ordWalletInscribe(walletName: string, containerFilePath: string, feeRateSatPerVb: number, extraArgs?: string[]): {
    commit: string;
    reveal: string;
};
/**
 * Assert the cat actually LANDED: output 0 of the confirmed tx pays the
 * recipient ordinals address with the fresh-cat postage. Ordinal theory
 * assigns the cat to the first sat of the first output, so a builder or
 * signer regression that swaps output order (change at vout 0) or routes
 * vout 0 to the payment address mints the cat onto the WRONG sat while
 * locktime/parser checks stay green. Chain-truth from electrs, not from
 * locally decoded bytes.
 */
export declare function assertCatLandsAtRecipient(tx: EsploraTx, recipientAddress: string, expectedPostageSats?: number): void;
export declare function assertAllInputsSighashAll(tx: EsploraTx): void;
/** Build an inscription id from txid + output index (`<txid>i<index>`). */
export declare function inscriptionId(txid: string, index?: number): string;
/**
 * Poll stock ord's HTTP server until it answers `/status` with a
 * 2xx. Same warm-up rationale as `waitForOrdReady`.
 */
export declare function waitForOrdStockReady(timeoutMs?: number): Promise<void>;
/**
 * Block until stock ord has indexed up to (at least) `targetHeight`.
 * ord's indexer lags bitcoind by a few hundred ms; without this gate
 * the inscription-lookup assertions race the indexer.
 */
export declare function waitForOrdStockSync(targetHeight: number, timeoutMs?: number): Promise<void>;
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
export declare function getStockOrdInscription(id: string): Promise<StockOrdInscription>;
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
export declare function getStockOrdOutputInscriptions(outpoint: string): Promise<string[]>;
/** Stock ord's `/output/<outpoint>` JSON, the fields the specs read. */
export interface StockOrdOutput {
    value: number;
    inscriptions: string[];
    /** `[start, end)` sat ranges in output order (ord runs with `--index-sats`). */
    sat_ranges: Array<[number, number]>;
    /** Rune balances, keyed by spaced name. `null` when ord has no rune index. */
    runes?: Record<string, {
        amount: number;
        divisibility: number;
        symbol: string;
    }> | null;
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
export declare function seedRuneCoin(options?: {
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
}): Promise<SeededRuneCoin>;
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
export declare function seedInscribedCoin(options: {
    address: string;
    /** Preferred name, matching every other seed helper. */
    valueSats?: number;
    /** Older name for the same thing. */
    postageSats?: number;
    walletName?: string;
    feeRate?: number;
}): Promise<SeededInscribedCoin>;
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
export declare function seedRareSatCoin(options?: {
    address?: string;
    valueSats?: number;
}): Promise<SeededRareSatCoin>;
/** ord's own verdict on a sat: `GET /sat/<sat>`, which carries its rarity. */
export declare function getStockOrdSat(sat: number): Promise<{
    rarity: string;
    number: number;
}>;
export declare function getStockOrdOutput(outpoint: string): Promise<StockOrdOutput>;
/** A fresh receive address of an ord-stock wallet (`ord wallet receive`). */
export declare function ordStockWalletReceive(walletName: string): string;
/** `ord wallet outputs` in the ord-stock container. */
export declare function ordStockWalletOutputs(walletName: string): Array<{
    output: string;
    amount: number;
    inscriptions?: string[];
}>;
/**
 * A fresh 1 BTC P2WPKH UTXO in the `ordpool-e2e` wallet whose first sat
 * carries no inscription, for building SDK inscriptions that stock ord must
 * index as blessed. Inscribing onto an already-inscribed sat is a
 * reinscription, and the pool can hand one out (see
 * {@link getStockOrdOutputInscriptions}), so this re-funds until it gets a
 * clean one. Sign the SDK commit with `walletprocesspsbt` on `ordpool-e2e`.
 */
export declare function fundUninscribed(): Promise<{
    fundingAddr: string;
    fundingPubkey: Uint8Array;
    utxo: {
        txid: string;
        vout: number;
        value: number;
    };
}>;
/**
 * Fetch the raw body bytes of an inscription from stock ord's
 * `/content/<id>` endpoint. ord returns the bytes verbatim with the
 * envelope's content-type as the response Content-Type header — same
 * shape every recursive-inscription consumer sees.
 */
export declare function getStockOrdContent(id: string): Promise<{
    bytes: Uint8Array;
    contentType: string | null;
}>;
/**
 * Poll until stock ord serves the inscription. ord indexes inscriptions
 * one or two blocks after the reveal lands; this helper hides the
 * polling boilerplate.
 */
export declare function waitForOrdStockInscription(id: string, timeoutMs?: number): Promise<StockOrdInscription>;
export declare function ordStockCli(...args: string[]): string;
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
export declare function ordStockCliAsync(...args: string[]): Promise<string>;
export declare function ordStockCreateWallet(name: string): string;
/**
 * Write `content` to `containerPath` inside the ord-stock container. The
 * bytes go over stdin, so any size works (an argv string is capped by the
 * OS's argument-length limit).
 */
export declare function writeOrdStockFile(containerPath: string, content: Uint8Array): void;
export declare function ordStockWalletInscribe(walletName: string, containerFilePath: string, feeRateSatPerVb: number, extraArgs?: string[]): {
    commit: string;
    reveal: string;
};
/**
 * `ord wallet batch --fee-rate <R> --batch <FILE>` in the ord-stock
 * container. `batchYaml` is the batchfile's text; file paths inside it are
 * container paths (write them with {@link writeOrdStockFile} first).
 */
export declare function ordStockWalletBatch(walletName: string, batchYaml: string, feeRateSatPerVb: number): {
    commit: string;
    reveal: string;
    inscriptions: Array<{
        id: string;
        location: string;
    }>;
};
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
export declare function fundOrdStockWallet(walletName: string, btc?: string): Promise<string>;
/**
 * Pay `outputs` (address -> BTC amount string) from ONE `ordpool-e2e` coin
 * that stock ord reports as carrying no inscription, then mine a block and
 * wait for electrs and stock ord. The funder wallet also receives
 * inscriptions from other specs, and if Core's coin selection spent one of
 * those, the recipients would get an inscribed sat: an ord wallet then sees
 * its funding as ordinal and refuses it with "no cardinal utxos". Returns
 * the transaction id; output i pays the i-th entry of `outputs`.
 */
export declare function sendFromCleanFunderCoin(outputs: Record<string, string>): Promise<string>;
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
export declare function makeWatchOnlyTestAccount(options?: {
    seed?: Uint8Array;
    accountPath?: string;
}): WatchOnlyTestAccount;
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
export declare function seedListedCat(options: {
    ordinalsAddress: string;
    valueSats?: number;
}): Promise<SeededListedCat>;
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
export declare function seedDirtyCoin(options: {
    asset: DirtyCoinAsset;
    address: string;
    valueSats: number;
    /**
     * Which ord-side wallet does the seeding. Defaults to one name per asset
     * class, which is fine for a single spec and collides the moment TWO specs
     * seed the same class against one bitcoind: they share a wallet, its funding,
     * and its UTXO set, so each run's coin selection depends on the other's.
     *
     * Pass distinct names to decouple them. Distinct wallets beat a shared
     * idempotent one here, because the hazard is not creating a wallet twice
     * (`ordStockCreateWallet` already tolerates that), it is two specs drawing
     * from the same coins.
     *
     * Only `inscription` and `rune` consult it: those seed through an ord stock
     * wallet. `cat` and `rareSat` build raw transactions against the bitcoind
     * wallet and have no ord wallet to collide over.
     */
    walletName?: string;
}): Promise<SeededDirtyCoin>;
//# sourceMappingURL=regtest-helpers.d.ts.map