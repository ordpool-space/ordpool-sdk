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

Body + content type, `delegate`, `metadata` (CBOR bytes), `metaprotocol`,
`parent` (ONE), `pointer`, `contentEncoding` (brotli), `properties` (CBOR
bytes, which is where gallery + attributes live), `propertyEncoding`, `note`,
`rune` commitment, `minimalTagPush`, a raw `envelopeFields` escape hatch, and
an optional `tip`.

Around that: commit+reveal orchestration, nine wallet signers, fee simulation
before anything is signed, a proven child/parent reveal flow, and
**byte-parity with live `ord wallet inscribe` proven on regtest**
(`e2e/regtest/inscribe-ord-parity-roundtrip.spec.ts`, plain + metaprotocol,
and stock ord blesses the SDK's inscription).

## 3. The gaps, worst first

### 3.1 Postage is hard-coded at 546 and cannot be set

`INSCRIBE_POSTAGE_SATS = CAT21_POSTAGE_SATS` in
`inscription-commit.helper.ts`, used directly by both the commit and reveal
builders. There is no input for it anywhere.

ord defaults to **10 000** and exposes `--postage`. So we differ from ord's
default by ~18x on every inscription, and a user who wants more padding
cannot ask for it.

**CORRECTED (2026-09-11).** This section first called the 546 a bug, because
its comment cited an HQ rule that said the opposite. The maintainer: 546 is
simply CHEAPER, and it is the common denominator across tools. Only the stale
rule citation was wrong, and it is fixed in `5602cb9` along with seven
siblings.

So the gap is narrower than written: the DEFAULT is right and stays 546.
Copying ord's 10 000 would cost a user 9 454 sats of padding they did not ask
for. What is missing is only the OPTION, for someone who wants more padding.

### 3.2 No batch, at all

ord's four batch modes are its most powerful inscription feature. The SDK does
exactly one inscription per commit+reveal. Nothing about collections, no
shared-output, no same-sat, no per-entry destinations.

This is the biggest functional gap and the most work. It is also the one a
collection launcher notices in the first minute.

### 3.3 Gallery and title exist only as hand-built CBOR

The bytes are supported (tag `0x11`), so capability parity holds. Ergonomic
parity does not, and this is the half the claim rests on. ord:

```
--gallery <ID> --gallery <ID> --title "My Piece"
```

SDK: build an INTEGER-keyed CBOR `Map` yourself, with a documented footgun
that a plain object silently produces text keys that ord drops.

For a claim whose second clause is "an interface that doesn't suck", asking a
consumer to hand-assemble a CBOR map with a silent-failure mode is the single
most embarrassing item on this list. It is also the cheapest to fix: a typed
`gallery?: string[]` and `title?: string` that encode internally.

### 3.4 One parent, where ord takes many

`parent?: string`. Tag `0x03` is repeatable and ord's batchfile takes a list.
The `envelopeFields` escape hatch can emit it, which is not an interface.

### 3.5 No sat / satpoint targeting

Cannot say "inscribe onto this specific sat". ord can, and this is the rare-sat
inscribing path, which is exactly the audience that cares about ordinals
theory rather than JPEGs.

### 3.6 The UI exposes a subset of the SDK

`inscribe-mint.component.ts` offers: file or delegate, metadata (key/value or
JSON), and brotli compression with an automatic assessment. It does NOT expose
parent, gallery, title, metaprotocol, pointer or postage, all of which the SDK
already supports today.

So part of "feature parity" needs no SDK work at all, only UI. That is the
cheapest progress available and it should be done first.

## 4. Where we are ALREADY better, and it is not a small list

- **No CLI, no node, no `bitcoin-core` wallet, no `ord wallet create`.** ord
  requires a synced index and a funded Core wallet before the first byte is
  inscribed. We need a browser and any of nine wallets.
- **Free**, with an optional tip rather than a service cut.
- **Fees simulated before signing**, against the real funding input, instead of
  discovering the cost after `--dry-run` on a CLI.
- **Compression is assessed and recommended**, not a flag you must know to pass.
- **Byte-parity is proven, not claimed** — the one thing on this page backed by
  a live regtest round-trip against stock ord.
- Two CAT-21 cats per inscribe, free, which ord structurally cannot do.

## 5. What the claim needs

**"Free"** is true today.

**"An interface that doesn't suck"** is true today and is our strongest half.

**"Feature parity"** is NOT true today, and saying it now would be the kind of
number-shaped claim this workspace bans. The honest ordered path:

1. **UI surfacing (§3.6)** — no SDK work, immediate, unlocks parent, gallery
   once §3.3 lands, metaprotocol, pointer.
2. **Gallery + title as typed inputs (§3.3)** — small, high embarrassment
   reduction.
3. **Postage (§3.1)** — small, and fixes a misapplied rule.
4. **Multiple parents (§3.4)** — small.
5. **Sat/satpoint targeting (§3.5)** — medium.
6. **Batch (§3.2)** — large, and the last thing standing between us and the
   word "parity".

Until 6 ships, the defensible claim is narrower and still strong: **"Everything
ord can inscribe, without the command line"** is false; **"Inscribe on Bitcoin
from your browser, free, with fees you see before you sign"** is true and needs
no caveat.
