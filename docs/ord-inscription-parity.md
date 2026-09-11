# Inscription parity with ord: what is left

Goal: be able to say **"Inscribe on Bitcoin. Free, feature parity with ord, and
an interface that doesn't suck."** Runes are out of scope by instruction.

Everything below was read from source on 2026-09-11, not recalled:
ord's `src/subcommand/wallet/inscribe.rs`, `src/wallet/batch/{file,entry,mode}.rs`,
`src/properties.rs`, `src/subcommand/wallet/shared_args.rs`; the SDK's
`src/inscribe/*`; ordpool's `inscribe-mint.component.ts`.

## 1. What ord can do

**`ord wallet inscribe`** (one inscription): `--file` or `--delegate` (one
required), `--cbor-metadata` / `--json-metadata`, `--destination`, `--gallery`
(repeatable), `--metaprotocol`, `--parent`, `--postage` (default 10000sat),
`--reinscribe`, `--sat`, `--satpoint`, `--title`, plus shared
`--fee-rate`, `--commit-fee-rate`, `--compress` (brotli), `--dry-run`,
`--no-backup`.

**`ord wallet batch`** (a batchfile), which is where ord's real power is:

- `mode`: `same-sat` | `satpoints` | `separate-outputs` | `shared-output`
- `parents`: a LIST, not one
- batch-level `postage`, `reinscribe`, `sat`, `satpoint`
- per entry: `file`, `delegate`, `destination`, `gallery`, `metadata`,
  `metaprotocol`, `satpoint`, `attributes` (`title` + `traits`)

## 2. What the SDK can do

Body + content type, `delegate`, `metadata` (CBOR bytes, or ord's JSON
conversion via `encodeJsonMetadata`), `metaprotocol`, `parent` (ONE),
`pointer`, `contentEncoding`, typed `gallery` + `title`, raw `properties`
(CBOR bytes) as the escape hatch, `propertyEncoding`, `postageSats`, `note`,
`rune` commitment, `minimalTagPush`, a raw `envelopeFields` escape hatch, and
an optional `tip`. `compressLikeOrd` and `compressProperties` compress exactly
as `--compress` does.

Around that: commit+reveal orchestration, nine wallet signers, fee simulation
before anything is signed, and a proven child/parent reveal flow.

**Byte-parity with live `ord wallet inscribe` is proven on regtest** for
everything in the status table of `ord-parity-masterplan.md`, and stock ord
blesses the SDK's inscriptions.

## 3. The gaps, worst first

### 3.2 Batch: the `satpoints` mode

`createBatchInscribeTransactions` and `createBatchChildInscribeTransactions`
build ord's `separate-outputs`, `shared-output` and `same-sat` batches, with
or without parents, byte-identically. Still missing: the `satpoints` mode,
which needs sat targeting (§3.5).

### 3.4 Several parents

ord takes several parents only in a batchfile (`wallet inscribe --parent`
takes one). The SDK matches that: `parents` on the batch builders, spent and
returned by the reveal, one `parent` tag per parent in every envelope.

### 3.5 No sat / satpoint targeting

Cannot say "inscribe onto this specific sat". ord can, and this is the rare-sat
inscribing path, which is exactly the audience that cares about ordinals
theory rather than JPEGs.

### 3.6 The UI exposes a subset of the SDK

`inscribe-mint.component.ts` offers: file or delegate, metadata (key/value or
JSON), and brotli compression with an automatic assessment. It does NOT expose
parent, gallery, title, metaprotocol, pointer or postage, all of which the SDK
supports.

So part of "feature parity" needs no SDK work at all, only UI. That is the
cheapest progress available and it should be done first.

## 4. Where we are ALREADY better, and it is not a small list

- **No CLI, no node, no `bitcoin-core` wallet, no `ord wallet create`.** ord
  requires a synced index and a funded Core wallet before the first byte is
  inscribed. We need a browser and any of nine wallets.
- **Free**, with an optional tip rather than a service cut.
- **Fees simulated before signing**, against the real funding input, instead of
  discovering the cost after `--dry-run` on a CLI.
- **Compression is assessed and recommended**, not a flag you must know to
  pass, and when brotli wins the bytes are the ones ord's `--compress` writes.
- **Byte-parity is proven, not claimed**: every supported option is compared
  byte for byte against live stock ord on regtest.
- Two CAT-21 cats per inscribe, free, which ord structurally cannot do.

## 5. What the claim needs

**"Free"** is true today.

**"An interface that doesn't suck"** is true today and is our strongest half.

**"Feature parity"** is NOT true today, and saying it now would be the kind of
number-shaped claim this workspace bans. The honest ordered path:

1. **UI surfacing (§3.6)**: no SDK work, unlocks parent, gallery, title,
   metaprotocol, pointer and postage in the form.
2. **Sat/satpoint targeting (§3.5)**: medium.
3. **The `satpoints` batch mode (§3.2)**: the last thing standing between us
   and the word "parity".

Until batch ships, the defensible claim is narrower and still strong: **"Everything
ord can inscribe, without the command line"** is false; **"Inscribe on Bitcoin
from your browser, free, with fees you see before you sign"** is true and needs
no caveat.
