# Inscribe features: what the SDK offers, and how to use it

Everything `ord wallet inscribe` and `ord wallet batch` can do, except runes,
is in the SDK and proven against live ord on regtest (the proof for each is
in the status table of `ord-parity-masterplan.md`). This page is the
consumer's view: which input does what, which builder or orchestrator takes
it, and what a UI has to know about it.

## Entry points

| Use | Orchestrator (builds, signs, broadcasts) | Builder (pure) |
|---|---|---|
| One inscription | `inscribeAndBroadcast` | `createInscribeTransactions` |
| One inscription, one parent | `inscribeChildAndBroadcast` | `createChildInscribeTransactions` |
| Several inscriptions in one go (ord's batch) | `inscribeBatchAndBroadcast` | `createBatchInscribeTransactions`, `createBatchChildInscribeTransactions` |
| The stateful UI flow (fee preview, UTXO picker, mint) | `InscribeMintOrchestrator` | |

`InscribeMintOrchestrator` is what ordpool.space uses. Its `InscribeContent`
carries the single-inscription options below (title, traits, gallery,
compressProperties, postage, satOffset, satSource, paddingUtxo,
commitFeeRatePerVbyte, and the existing parent, metadata, metaprotocol,
delegate, pointer), and its fee preview prices exactly what the build signs.
`compressProperties` needs `brotliWasm` in its deps. Batch and parents in
the orchestrator follow, shaped by what the inscribe screen needs.

## Options on a single inscription

| Option | ord flag | What it does | UI notes |
|---|---|---|---|
| `body` + `contentType` | `--file` | The content. Optional when `delegate` is set. | The drag-and-drop file. |
| `delegate` | `--delegate` | Serve another inscription's content. With no body, ord serves only the delegate's. | One inscription id. |
| `parent` | `--parent` | One parent; the reveal spends it. Use `inscribeChildAndBroadcast`. | The wallet signs twice: commit, then the parent input. |
| `title` | `--title` | The inscription's name, shown by ord under the number. An empty string is written too. | A text field. |
| `traits` | batchfile `traits:` | Name/value pairs in order: bool, integer, null or string. | An ordered list editor; pass a `Map` or an array of pairs. |
| `gallery` | `--gallery` (repeatable) | Makes this inscription a gallery of other inscriptions; items may carry their own title and traits. | Ids must exist; duplicates are refused. |
| `metadata` | `--cbor-metadata` | CBOR bytes as given. | |
| `encodeJsonMetadata(text)` | `--json-metadata` | Turns JSON text into the CBOR ord writes (key order, number types, float widths all as ord). | Pass the file's text, not a parsed object. |
| `metaprotocol` | `--metaprotocol` | A metaprotocol string. | |
| `postageSats` | `--postage` | The inscription output's value. Default 546 (ord's default is 10 000; 546 is cheaper). | |
| `compressLikeOrd(body, contentType, wasm)` | `--compress` | brotli exactly as ord: returns the body to inscribe and `contentEncoding: 'br'` when it is smaller. | Loads the wasm; see Compression. |
| `compressProperties` | `--compress` | Also compresses gallery/title/traits when that is smaller. | The wasm must be loaded first. |
| `satOffset` | `--satpoint <funding>:<offset>` | Inscribe onto a sat inside the funding UTXO. | |
| `findSatOffset(satRanges, sat)` | `--sat` | A sat number to its offset, from ord's `/output` `sat_ranges`. | Needs an ord with a sat index. |
| `satSource` | `--satpoint <other utxo>:<offset>` | Inscribe onto a sat in a UTXO other than the funding one, e.g. a rare sat at the ordinals address. Its other sats go back to its address; the funding pays the fee. | The wallet signs the commit as a transfer (ordinals input 0, funding 1). |
| `paddingUtxo` | (ord pads automatically) | For a chosen sat less than a dust limit into its UTXO: a second payment UTXO pads the padding output, as ord does. | Only accepted when needed; a clear error says how much. |
| `commitFeeRatePerVbyte` | `--commit-fee-rate` | The commit at its own fee rate; the reveal stays at `feeRatePerVbyte`. | An advanced setting. |
| `noLimit` | `--no-limit` | Allow a reveal above the 400 000 weight-unit relay limit. Nodes will not relay it. | Not for normal users. |
| `recipientAddress` | `--destination` | Where the inscription goes. | |
| `pointer` | (batch writes it) | Sat offset of the inscription in the reveal's outputs. | Rarely needed by hand. |

## Batch

`inscribeBatchAndBroadcast({ mode, inscriptions, postageSats, recipientAddress, parents?, ... })`

| `mode` | Reveal outputs | Each inscription lands on |
|---|---|---|
| `separate-outputs` | one per inscription | the first sat of its own output (a per-entry `destination` is allowed) |
| `shared-output` | one, all postages together | its own sat inside that output, one postage apart |
| `same-sat` | one | the same sat, all of them (`satOffset` allowed here) |
| `satpoints` | one per inscription, each the value of its own UTXO | the first sat of that inscription's own UTXO (`entry.satpoint`) |

Each entry takes `body`, `contentType`, `contentEncoding`, `metadata`,
`metaprotocol`, `delegate`, `gallery`, `title`, `traits`,
`compressProperties`, and in the matching modes `destination` and
`satpoint`. `parents` (several allowed) are spent and returned by the
reveal and named in every envelope. With `parents` or in `satpoints` mode
the wallet signs twice: the commit, then the parent and satpoint inputs of
the reveal (`walletInputCount` of them, all at the ordinals address). The
result lists where each inscription lands (`vout`, `offset`); inscription i
is `<revealTxid>i<i>`.

## Compression

The SDK ships `wasm/brotli_wasm_bg.wasm`, built from the Rust `brotli` crate
at the version ord uses and called with ord's settings, so its output is the
bytes `ord wallet inscribe --compress` writes. The consumer hosts the file
and passes its URL (`brotliWasmUrl` to `assessCompression`, or the URL or
bytes to `compressLikeOrd` / `loadBrotliWasm`).

- `compressLikeOrd` is ord's rule exactly: brotli, kept only when smaller.
- `assessCompression` is the "is it worth it" helper for a UI: it also tries
  gzip and applies a minimum saving. When given the wasm URL it uses ord's
  encoder on every browser; without one it falls back to the browser's
  built-in brotli where there is one (valid, but not ord's bytes).

## Signing, per shape

| Shape | Wallet prompts | Signer method |
|---|---|---|
| Plain inscription, batch without parents | 1 (commit) | `signSingleFundingInput` |
| `satSource` | 1 (commit, two inputs) | `signTransfer` |
| `paddingUtxo` | 1 (commit, two or three inputs) | `signPaddedSatCommit` |
| One parent, batch with parents or `satpoints` | 2 (commit, then the reveal's wallet inputs) | `signSingleFundingInput`, then `signChildRevealParentInputs` |

The reveal of a plain inscription is signed by the SDK's own one-time key;
the wallet never sees it.

## What a consumer must provide

- The funding UTXO (and a second one for `paddingUtxo`), from the wallet.
- For sat targeting: the sat's UTXO and its `sat_ranges`, from an ord with a
  sat index (`GET /output/<outpoint>` with `Accept: application/json`).
- For parents and `satpoints`: the UTXOs with their script and x-only
  internal key; they must sit at the connected wallet's ordinals address.
- The hosted brotli wasm, if compression is offered.
- For gallery items and delegates: that the ids exist. ord refuses ids its
  index does not have; `checkInscriptionsExist(ids, { ordBaseUrl })` looks
  each up (`GET /inscription/<id>`) and reports `exists`, `missing`,
  `invalid` or `unknown` (a failed lookup, never taken as missing).
