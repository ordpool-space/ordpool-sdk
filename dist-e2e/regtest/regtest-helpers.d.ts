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
//# sourceMappingURL=regtest-helpers.d.ts.map