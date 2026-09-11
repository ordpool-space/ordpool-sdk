# Master plan: inscription parity with ord

Goal: earn the claim **"Inscribe on Bitcoin. Free, feature parity with ord,
and an interface that doesn't suck."** Runes excluded by instruction.

The gap analysis is in `ord-inscription-parity.md`. This is the order of work,
what each step actually costs, and what "done" means for each.

## 0. Correction to the analysis: postage is NOT a bug

The parity doc called the hard-coded 546 "arguably a bug" because its comment
cited an HQ rule that said the opposite. The maintainer's answer: **546 is
simply cheaper**, it is the common denominator across tools, and the stale
rule text was the only thing wrong. That is fixed (`5602cb9`).

**So 546 STAYS as our default**, and ord's 10 000 is not a target to copy. The
work in §3 is adding the option, not changing the default. Padding an
inscription to 10 000 costs the user 9 454 sats for nothing unless they asked
for it.

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

## 2. Gallery and title as typed inputs

Today: hand-build an integer-keyed CBOR `Map`, with a silent failure if you
use a plain object (text keys, which ord drops).

Wanted:

```ts
gallery?: string[];    // inscription ids
title?: string;
traits?: …;            // ord's Attributes.traits, shape TBD from properties.rs
```

encoded internally into tag `0x11`, with the existing raw `properties` kept as
the escape hatch for anything we have not typed yet.

This is the single highest embarrassment-per-line item on the list: it is the
gap between "capability parity" and "an interface that doesn't suck", and it is
maybe a day.

Done when: a consumer can put three inscriptions in a gallery and a title on
an inscription without touching CBOR, a byte-parity regtest proves the
envelope matches `ord wallet inscribe --gallery … --gallery … --title …`, and
the existing raw path still works.

## 3. Postage as an option

`postageSats?: number`, defaulting to 546. Validate against the destination
address's dust floor and reject below it with a real message.

Done when: an inscription can be given a chosen postage, the default is
unchanged at 546, and a spec pins that omitting it still produces 546.

## 4. Multiple parents

`parent?: string` becomes `parents?: string[]` (keep `parent` as an accepted
alias so nothing breaks). Tag `0x03` repeats; ord's batchfile takes a list.

Done when: a two-parent inscription is byte-identical to ord's, proven on
regtest, and cat21.space's child-mint flow still passes.

## 5. Sat and satpoint targeting

Inscribe onto a chosen sat or satpoint rather than wherever coin selection
lands. This is the rare-sat audience, the people who care about ordinal theory
rather than JPEGs, and it is the first item that needs real selection work
rather than an envelope field.

Done when: `--sat`-equivalent and `--satpoint`-equivalent both work against a
regtest wallet holding a known rare sat, and the resulting inscription is on
the sat we asked for, verified through cat21-ord rather than by our own
arithmetic.

## 6. Batch

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

Nobody writes the parity sentence before §6. A claim that a competitor can
falsify in one command is worse than no claim, and `ord wallet batch
--mode same-sat` is exactly that command.
