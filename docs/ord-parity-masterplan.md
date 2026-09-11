# Master plan: inscription parity with ord

Goal: earn the claim **"Inscribe on Bitcoin. Free, feature parity with ord,
and an interface that doesn't suck."** Runes excluded by instruction.

The gap analysis is in `ord-inscription-parity.md`. This is the order of work,
what each step actually costs, and what "done" means for each.

## Status

Each "proven" row is a regtest spec that drives live stock ord and compares
bytes; see the spec for exactly what is compared.

| Item | Status | Proof |
|---|---|---|
| Plain + metaprotocol envelope | proven byte-identical | `e2e/regtest/inscribe-ord-parity-roundtrip.spec.ts` |
| `--gallery` / `--title` as typed inputs (§2) | proven byte-identical, inline and packed forms | `e2e/regtest/inscribe-properties-parity.spec.ts` |
| `--postage` as an option (§3) | proven at 546, 3 000, 10 000 and 30 000 sats | `e2e/regtest/inscribe-postage-parity.spec.ts` |
| `--parent` (one parent) | envelope byte-identical, reveal topology pinned | `e2e/regtest/inscribe-parent-parity.spec.ts` |
| `--cbor-metadata`, `--json-metadata`, `--delegate` | proven byte-identical | `e2e/regtest/inscribe-metadata-delegate-parity.spec.ts` |
| `--compress` (body and properties) | proven byte-identical across ord's text, generic and font modes, large bodies, and the 30:1 refusal | `e2e/regtest/inscribe-compress-parity.spec.ts` |
| Batch `separate-outputs` (§6a) | proven: tapscript, reveal outputs, reveal vsize, commit output and every inscription's location, at 546 and 3 000 sats, with per-entry destination, title, gallery items with titles, metaprotocol | `e2e/regtest/inscribe-batch-parity.spec.ts` |
| Batch `shared-output`, `same-sat` (§6b) | proven, same comparison | `e2e/regtest/inscribe-batch-parity.spec.ts` |
| SDK batches on chain | every mode broadcast; stock ord indexes each inscription at the satpoint the SDK reports, with its content | `e2e/regtest/inscribe-batch-parity.spec.ts` |
| Batch with parents, several parents (§4) | proven: a two-parent batch matches ord in tapscript, reveal outputs, reveal vsize, commit output and locations; an SDK batch spending two parents broadcasts, and stock ord links every child to both parents and returns both | `e2e/regtest/inscribe-batch-parity.spec.ts` |
| `--commit-fee-rate` | proven: the commit pays its own rate (ord's commit checked at round(2 x vsize)), the reveal keeps `--fee-rate`, the commit output matches ord | `e2e/regtest/inscribe-postage-parity.spec.ts` |
| Fractional fee rates | proven at 1.1, 1.3, 2.7 and 0.6 sat/vB: the SDK rounds fees as ord's `FeeRate::fee` does (round, not round-up), so the commit output matches ord | `e2e/regtest/inscribe-postage-parity.spec.ts` |
| `--no-limit` and ord's `MAX_STANDARD_TX_WEIGHT` refusal | proven: a 401 000-byte body is refused by ord and the SDK with the same message and the same weight; `noLimit` builds it | `e2e/regtest/inscribe-postage-parity.spec.ts` |
| Batch `traits`, an empty `--title ""` | proven byte-identical: traits in file order with every value type, on the inscription and on gallery items; ord writes an empty title and so does the SDK | `e2e/regtest/inscribe-batch-parity.spec.ts`, `e2e/regtest/inscribe-properties-parity.spec.ts` |
| `--destination` | proven with a P2WPKH destination: output script, value, reveal vsize and commit output match ord | `e2e/regtest/inscribe-postage-parity.spec.ts` |
| `--delegate` with no `--file`, as a transaction | an SDK delegate-only inscription broadcasts and stock ord serves the delegate's content for it | `e2e/regtest/inscribe-metadata-delegate-parity.spec.ts` |
| `--satpoint`, `--sat` (§5) for a sat inside the funding UTXO | proven: padding output and commit output match ord at offsets 1 000 and 50 000, and stock ord's sat index puts the SDK inscription on exactly the requested sat; `findSatOffset` turns a sat number into the offset | `e2e/regtest/inscribe-satpoint-parity.spec.ts` |
| Sat in a separate UTXO (`satSource`, e.g. a rare sat at the ordinals address) | proven: same commit output as ord; padding and the rest of that UTXO return to its address, the funding pays only the fee; a sub-dust remainder becomes postage; a UTXO smaller than the commit output is topped up; stock ord's sat index puts each inscription on the requested sat | `e2e/regtest/inscribe-satpoint-parity.spec.ts` |
| A sat less than a dust limit into its UTXO (`paddingUtxo`) | proven at offset 100: ord and the SDK both put a further input in front and make the padding its value + 100; same commit output; stock ord's sat index has the inscription on the requested sat, in the funding UTXO and in a satSource; signed through `signPaddedSatCommit` | `e2e/regtest/inscribe-satpoint-parity.spec.ts` |
| Batch `satpoints` (§6c) | proven: ord and the SDK spend the same three UTXOs (5 000, 7 000, 9 000 sats) and match in tapscript, reveal outputs, reveal vsize, commit output (the reveal fee only) and locations; an SDK satpoints batch on UTXOs we own broadcasts, and stock ord puts each inscription on the first sat of its UTXO | `e2e/regtest/inscribe-batch-parity.spec.ts` |

**Default postage stays 546.** It is cheaper, and it is the common
denominator across tools; ord's 10 000 is an option we offer, not a default
we copy. Padding an inscription to 10 000 costs the user 9 454 sats for
nothing unless they asked for it.

**`--compress` needs ord's encoder, not just brotli.** ord compresses with
the Rust `brotli` crate at lgwin 24 and a per-content-type mode, and that
crate's cost model calls the host's `log2f`, so ord's bytes are glibc's
bytes. The SDK ships the same crate compiled to wasm (`wasm-src/brotli-ord`)
with glibc's `log2f` ported in; `compressLikeOrd` and `compressProperties`
use it. Native `CompressionStream('brotli')` produces valid but different
bytes.

## 1. Surface what the SDK already does (UI only, no SDK work)

`ordpool`'s inscribe form exposes file/delegate, metadata and compression. The
SDK already supports `parent`, `metaprotocol`, `pointer` and `properties`
today, and nobody can reach them.

**Do this first.** It is the only step that adds capability with zero SDK
change, and it turns features we already shipped into features we can claim.

Done when: parent, metaprotocol and pointer are in the form, each with the
same measured-contrast and mutation-checked treatment as everything else this
quarter, and the form still fits on a phone.

Owner: ordpool session. Blocked by nothing.

## 2. Gallery and title as typed inputs (done)

`gallery` (bare ids or `{ id, title, traits }` items), `title` and `traits`,
encoded into tag `0x11` exactly as ord does: both the inline and packed forms
are built and the smaller wins, inline on a tie; traits keep their order. Raw
`properties` stays as the escape hatch for pre-encoded bytes.

## 3. Postage as an option (done)

`postageSats?: number`, defaulting to 546; it sets the reveal output and
therefore the commit output, both proven equal to ord's at several sizes.

## 4. Multiple parents (done, through batch)

`parent?: string` becomes `parents?: string[]` (keep `parent` as an accepted
alias so nothing breaks). Tag `0x03` repeats; ord's batchfile takes a list.

Done when: a two-parent inscription is byte-identical to ord's, proven on
regtest, and cat21.space's child-mint flow still passes.

## 5. Sat and satpoint targeting (done)

Inscribe onto a chosen sat or satpoint rather than wherever coin selection
lands. This is the rare-sat audience, the people who care about ordinal theory
rather than JPEGs, and it is the first item that needs real selection work
rather than an envelope field.

Done when: `--sat`-equivalent and `--satpoint`-equivalent both work against a
regtest wallet holding a known rare sat, and the resulting inscription is on
the sat we asked for, verified through cat21-ord rather than by our own
arithmetic.

## 6. Batch (done)

The big one, and the last thing between us and the word "parity". ord's four
modes:

| mode | what it does |
|---|---|
| `separate-outputs` | one output per inscription, each its own postage (ord's default) |
| `shared-output` | all inscriptions on ONE output |
| `same-sat` | all inscriptions on the SAME SAT |
| `satpoints` | each inscription onto a caller-specified satpoint |

Plus batch-level `parents`, `postage`, `sat`, `satpoint`, and per-entry
`file`, `delegate`, `destination`, `gallery`, `metadata`, `metaprotocol`,
`satpoint`, `attributes`.

**Suggested split, because this should not land as one change:**

- **6a** `separate-outputs` only, N inscriptions, one commit and one reveal,
  per-entry destination. That alone covers the collection-drop case, which is
  what most people mean when they say batch.
- **6b** `shared-output` and `same-sat`. Both are one-output variants and share
  most of the builder.
- **6c** `satpoints`, which depends on §5 landing first.

Done when: each mode is byte-compared against live `ord wallet batch` on
regtest at more than one size, per the rule that a 546-only test proves
nothing about size handling.

## 7. What we do NOT copy

- **Runes / etching.** Out of scope by instruction.
- **`--reinscribe`.** That is a guard on ord's own wallet, not an inscription
  capability. We should think about whether we want the guard, separately.
- **`--no-backup`, `--dry-run`.** CLI ergonomics with no browser equivalent;
  our simulation already covers what `--dry-run` is for, earlier in the flow.
- **`ord wallet create` / `restore` / `dump`.** We are not a wallet.

## 8. What the claim may say, and when

- **Today**: "Inscribe on Bitcoin from your browser. Free, and you see the fee
  before you sign." True now, needs no caveat.
- **After §1-§4**: add "parents, galleries, titles, delegates, metadata and
  metaprotocols", which is a list ord users recognise.
- **After §6a**: "and whole collections in one go."
- **After §6c**: "feature parity with ord" becomes defensible, and only then.
  Every row of the status table is proven, so for the SDK it is. For
  ordpool.space it waits on §1, the form that exposes it.

Nobody writes the parity sentence before §6. A claim that a competitor can
falsify in one command is worse than no claim, and `ord wallet batch
--mode same-sat` is exactly that command.
