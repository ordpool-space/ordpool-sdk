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
takes:

- `source`: `{ kind: 'file', body, contentType }` or
  `{ kind: 'delegate', delegate }`, so a screen asks once and hides the rest.
- `satTarget`: `{ kind: 'in-funding', offset }` or
  `{ kind: 'in-utxo', utxo, offset }`, plus `paddingUtxo` when the sat sits
  less than a dust limit into its coin. With `in-funding` the coin holding
  the sat must be chosen via `setSelectedUtxo`.
- the rest as plain fields: title, traits, gallery, compressBody and
  compressProperties (both need `brotliWasm` in the deps), postageSats,
  commitFeeRatePerVbyte, parent, metadata, metaprotocol, pointer, tip, note.

`compressBody: true` hands the file to ord's encoder during recompute: the
preview prices the compressed body, `content_encoding` is set for you, and
`snapshot.compression` reports `originalSize`, `compressedSize`, `savedBytes`
and the `contentEncoding` being written, or `contentEncoding: null` when
compressing did not shrink the file and the original is what gets inscribed
(ord's own rule). Each body is compressed once, so the bytes the preview
priced are the bytes `mint()` inscribes. Batch entries take the same flag and
`snapshot.compression` then carries the totals.

A chosen sat that sits less than a dust limit into its coin needs a second coin
to pad the output in front of it. The orchestrator sources that coin itself
when `paddingUtxo` is not set: the smallest clean coin covering the shortfall,
through the same content scan the funding pick uses, and removed from the
funding candidates so it cannot be spent twice. `snapshot.padding` reports
`{ utxo, shortfallSats, automatic }`, or `null` when no padding is needed.
(ord pads with several inputs if it must; the SDK's commit takes one, so a
wallet whose every spare coin is smaller than the shortfall reports an error
rather than combining. The shortfall is always under one dust limit.)

A batch can name its parents by id: set `parentIds` plus `deps.ordBaseUrl` and
the wallet's `ordinalsPublicKey`, and the orchestrator asks ord where each
parent sits, derives the keys the reveal signs with, and reports what it found
on `snapshot.parents` as `{ id, address, value, outpoint }`. A parent the
wallet cannot sign for is refused before anything is built.

Each funding coin in the snapshot carries a `preview`: commit and reveal
vsize and fee, total fee, postage, funding requirement, total spent, and
how many wallet prompts the shape needs (`null` when the coin cannot fund
it). `snapshot.signing` is non-null while the wallet is being asked to
sign, so a screen can say which signature is coming. `setBatch(batch)` inscribes several at once instead of one (the two replace
each other): ord's modes, entries with the same `source` union plus title,
traits, gallery, metadata, metaprotocol and a per-entry `destination` or
`satpoint`, optional `parents`. Its preview comes from the same planning the
batch build runs, and with parents or in `satpoints` mode it reports two
wallet prompts; `snapshot.signing` moves to step 2 once the commit is out,
naming which reveal inputs the wallet is about to sign.

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
| `compressBody` | `--compress` | The orchestrator compresses the body with ord's encoder and tags it, keeping it only when smaller. | A toggle; `snapshot.compression` has the saving. |
| `compressLikeOrd(body, contentType, wasm)` | `--compress` | The same rule as a plain function, for a consumer that compresses itself. | Loads the wasm; see Compression. |
| `compressProperties` | `--compress` | Also compresses gallery/title/traits when that is smaller. | The wasm must be loaded first. |
| `satOffset` | `--satpoint <funding>:<offset>` | Inscribe onto a sat inside the funding UTXO. | |
| `findSatOffset(satRanges, sat)` | `--sat` | A sat number to its offset, from ord's `/output` `sat_ranges`. | Needs an ord with a sat index. |
| `findRareSatsInOutputs(utxos, { ordBaseUrl })` | (ord's `wallet sats`) | Per coin: the rarest sat it holds, that sat's offset, the coin's address. Rows come back in order, one per coin; a failed lookup is `status: 'unknown'`, never "holds nothing". | Feeds a rare-sat picker; hand a picked row to `satTarget`. |
| `inscribeSatSourceFromRow(row, { ordinalsPublicKey, network })` | | A picker row to the `InscribeSatSource` that `satTarget` kind `in-utxo` takes, deriving the tweaked output script and the untweaked internal key. `null` when the row holds no rare sat or its lookup failed. | Throws `sat-utxo-key-mismatch` when the key does not own the coin, rather than building an unspendable commit. |
| `satPaddingRequirement(satOffset, paddingAddress)` | (ord pads automatically) | `{ needsPadding, shortfallSats, dustLimitSats }`, so the second coin is asked for up front instead of discovered from a failed build. | The address is the sat's OWN coin address for `in-utxo`, the payment address for `in-funding`. |
| `satSource` | `--satpoint <other utxo>:<offset>` | Inscribe onto a sat in a UTXO other than the funding one, e.g. a rare sat at the ordinals address. Its other sats go back to its address; the funding pays the fee. | The wallet signs the commit as a transfer (ordinals input 0, funding 1). |
| `paddingUtxo` | (ord pads automatically) | For a chosen sat less than a dust limit into its UTXO: a second payment UTXO pads the padding output, as ord does. Leave it out and the orchestrator sources one. | Only accepted when needed; a clear error says how much. |
| `selectPaddingUtxo(utxos, { satOffset, paddingAddress })` | (ord's `pad_alignment_output`) | The padding coin, or why none fits: `not-needed`, `selected`, or `none-covers` with the shortfall. | Only pass coins that are safe to spend; the orchestrator does this for you. |
| `batchParentFromInscriptionId(id, { ordBaseUrl, ordinalsPublicKey, network })` | | A parent inscription id to the `BatchParent` a batch takes, via ord's `/inscription` and `/output`. | Throws `parent-not-owned` when the wallet cannot sign for it. |
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

- `InscribeContent.compressBody` is the orchestrator doing it for you, and
  is what a screen with a "compress" toggle wants.
- `compressLikeOrd` is the same rule as a plain function: brotli, kept only
  when smaller.
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

## Errors a screen shows

Anything a person's input can cause throws an `InscribeInputError`: a stable
`code` (`invalid-inscription-id`, `insufficient-funds`,
`sat-offset-needs-padding`, `duplicate-trait`, `reveal-too-heavy`,
`body-or-delegate-required`, `output-below-dust`, …), a `userMessage`
written for a person, and the numbers in `details` (e.g.
`{ satOffset, dustLimit, neededPaddingSats }`), so a UI can show the
message as it is or word it itself by code. `inscribeUserMessage(err)`
returns the user message for our errors and the plain message otherwise.
`message` keeps the developer wording, so logging is unchanged. Internal
asserts and type checks stay plain `Error`s.

## What a consumer must provide

- The funding UTXO (and a second one for `paddingUtxo`), from the wallet.
- For sat targeting: an ord with a sat index. `findRareSatsInOutputs` does the
  `GET /output/<outpoint>` walk and the rarity ladder for you; pass its base
  URL. Inscribing on a chosen sat still needs that coin's script and x-only
  internal key from the wallet.
- For parents and `satpoints`: the UTXOs with their script and x-only
  internal key; they must sit at the connected wallet's ordinals address.
- The hosted brotli wasm, if compression is offered.
- For gallery items and delegates: that the ids exist. ord refuses ids its
  index does not have; `checkInscriptionsExist(ids, { ordBaseUrl })` looks
  each up (`GET /inscription/<id>`) and reports `exists`, `missing`,
  `invalid` or `unknown` (a failed lookup, never taken as missing).
