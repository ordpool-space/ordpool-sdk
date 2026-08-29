# CLAUDE.md

## Overview

**ordpool-sdk** is the higher-level domain library for the ordpool ecosystem. It sits one layer above [`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser): the parser extracts artifacts from raw transactions; the SDK does everything one step up from that — REST wrappers, calendar clients, signing helpers, anything that needs to talk to a network or hold side-effecting logic.

- **MIT licensed.**
- **Two entry points** (see "Two entry points" section below):
  - `ordpool-sdk` — Angular Package Format bundle for cat21.space.
  - `ordpool-sdk/core` — plain CommonJS for cat21-wallet and any
    other non-Angular consumer.
- Works in Node.js AND browsers.
- No external consumers yet — only `ordpool.space`, `cat21.space`, and
  `cat21-wallet` use it. No CHANGELOG, no semver gymnastics.

## Two entry points: `ordpool-sdk` vs `ordpool-sdk/core`

The SDK ships pure helpers AND Angular `@Injectable` services in the
same source tree. Both genuinely belong here — pure helpers are the
reusable primitives, Angular services are cat21.space's stateful
orchestrators. They cannot share one entry point because Angular's
bundler emits `import * as i0 from '@angular/core'` at the top of
the fesm bundle, and any consumer that imports from that bundle
pulls Angular into their build.

So the SDK has two parallel build outputs:

| Entry point | Build tool | Output | For |
|---|---|---|---|
| `ordpool-sdk` | `ng-packagr` (Angular AOT) | `dist/fesm2022/ordpool-sdk.mjs` + `dist/index.d.ts` | cat21.space (Angular app) |
| `ordpool-sdk/core` | plain `tsc` | `dist-core/core.js` (CommonJS) + `dist-core/core.d.ts` + per-file emit | cat21-wallet, any plain Node/Webpack/Vite consumer |

`package.json` `exports` map wires the resolution. Consumers
write:

```ts
// cat21.space (Angular):
import { Cat21Service, buildCat21TransferPsbt } from 'ordpool-sdk';

// cat21-wallet (React + Webpack, no Angular):
import { buildCat21TransferPsbt } from 'ordpool-sdk/core';
```

### What goes in `core.ts`

`src/core.ts` is the manifest for the `/core` subpath. Re-export
ONLY symbols whose entire transitive import graph is Angular-free.

Allowed:
- Pure functions and types (`buildCat21TransferPsbt`,
  `evaluateAgentPolicy`, `Network`, `KnownOrdinalWalletType`, …).
- Constants and enums.
- Files under `cat21-mint/cat21.service.helper.ts`,
  `cat21-mint/cat21.service.types.ts`,
  `cat21-mint/cat21-mint.helper.ts`,
  `cat21-transfer/*`,
  `cat21-offer/*`,
  `cat21-broadcast/*`,
  `agent-mode/*`,
  `wallet/wallet.service.types.ts`,
  `wallet/wallet-logos.ts`,
  `network.ts`.

NOT allowed (stays in main entry only):
- `WalletService`, `Cat21Service`, `Cat21ApiService`,
  `Cat21MintOrchestrator`, `UtxoContentScanner` — Angular
  `@Injectable` classes.
- `InjectionToken` constants (`storage`, `bitcoinNetwork`,
  `cat21SdkConfig`).
- Anything that imports `@angular/*`.

When adding a new pure helper:

1. Create the file under `src/`.
2. Export from its own file as usual.
3. Re-export from `src/core.ts`.
4. Add the source file to the `include` list in `tsconfig.core.json`.
5. `npm run build` (or just `npm run build:core` if you only
   changed pure code) — regenerates BOTH dist outputs.

When adding a new Angular-using piece:

1. Create the file under `src/`.
2. Export from `src/index.ts` ONLY (NOT `src/core.ts`).
3. Don't add to `tsconfig.core.json`.

If a refactor accidentally adds an Angular dependency to a file
that's already in `core.ts`, the tsc-only build at `npm run
build:core` fails (no Angular shims in the core tsconfig). That's
the structural guard.

### Build commands

```bash
npm run build           # builds both entry points
npm run build:angular   # ng-packagr for the main entry only
npm run build:core      # tsc for the /core entry only
npm run clean           # removes dist/ AND dist-core/
```

`prepare` hook on install runs `npm run build`, so a fresh clone
or `npm install` produces both outputs.

### Consumer-side staleness guard

cat21-wallet imports the COMPILED bytes from `dist-core/`, not
`src/*.ts`. If you edit SDK source without rebuilding, the wallet
runs against stale bytes. The wallet ships a pre-hook
(`apps/extension/scripts/check-sdk-fresh.cjs`) that fires before
`vitest`, `webpack`, and `tsc`; if `src/` mtimes are newer than
`dist-core/` mtimes, it exits 1 with the rebuild command.

In wallet-side dev, a side-terminal `pnpm sdk:watch` keeps the
core build incremental, so you never trip the guard.

## HARD RULE: Keep useful comments

**Don't strip JSDoc or "why" inline comments under the banner of
"simplification".** The text inside a comment can be trimmed (no
bombast, no LLM-speak, no before-after history); the block itself
stays. Wallet quirks, coin-selection rationale, and signing-flow
edge cases are exactly the kind of comment a future reader cannot
reconstruct from code alone. Full decision tree in the workspace
`CLAUDE.md` HARD RULE "Keep useful comments (JSDoc AND inline 'why')".

## HARD RULE: signingMap is BANNED — every Bitcoin operation ships as a typed triple

**`signingMap` is a footgun, not a primitive.** The previous design exposed
a `signingMap: ReadonlyArray<PsbtSigningTarget>` parameter on
`signMultiInputAndBroadcast` / `signPsbtOnly`. A caller could pass an
array that missed an input index; the wallet signed what was listed,
auto-finalizing wallets emitted a partially-finalized PSBT, and
broadcast landed at electrs with `mandatory-script-verify-flag-failed`
AFTER the user clicked Sign. Worse: per-row `sigHash` overrides made
"change the commitment topology" a silent typo.

**Every on-chain Bitcoin operation ships as a TYPED TRIPLE:**

1. **Builder** (internal): pure function that constructs the PSBT
   bytes for that operation. Owns the input layout (cat at index 0,
   funding inputs at 1..N, etc.). Lives in
   `cat21-{mint,transfer,offer}/…helper.ts` /
   `inscribe/inscription-commit.helper.ts`.

2. **Signer method** (internal, on every `WalletSigner`): operation-
   named method with a HARDCODED signing topology. The four shipping
   methods today:

   - `signSingleFundingInput` — 1 input at paymentAddress, SIGHASH_ALL
     (mint, inscribe-commit, future RBF replacement, future CPFP child).
   - `signTransfer` — input 0 = ordinalsAddress, inputs 1..N =
     paymentAddress, all SIGHASH_ALL. Caller only states
     `fundingInputCount`; positions are derived.
   - `signOfferAccept` — input 0 = ordinalsAddress; nothing else
     touched. Buyer's inputs come pre-signed.
   - `signOfferCreatePsbt` — inputs 1..N = paymentAddress; returns
     partial-sig PSBT bytes (no broadcast).

   No method takes a `signingMap`. No method takes a `sigHash`
   override. Topology is the method name.

3. **Orchestrator** (PUBLIC API): operation-named entry point that
   composes builder + signer + broadcast callback. The only Bitcoin-
   operation surface a consumer sees. Examples:
   `Cat21Service.createCat21Transaction` (mint),
   `Cat21TransferOrchestrator.transfer`,
   `Cat21CreateOfferOrchestrator.createOffer`,
   `Cat21AcceptOfferOrchestrator.acceptOffer`,
   `inscribeAndBroadcast`. Future RBF / CPFP / Bitcoin-send /
   rune-etch operations get a sibling orchestrator following the
   same pattern.

**The signer interface (`WalletSigner`) and the per-method input
shapes (`SignSingleFundingInputArgs`, `SignTransferArgs`,
`SignOfferAcceptArgs`, `SignOfferCreatePsbtArgs`) are NOT exported
through `core.ts` or `index.ts`.** Consumers can't reach them without
a deep import that the package `exports` map blocks. The only public
Bitcoin-operation surface is orchestrators.

**When adding a new on-chain operation:**

1. Write the builder under `src/<operation>/<operation>.helper.ts`.
2. Add a sibling signer method to `WalletSigner` (operation-named,
   hardcoded topology). Implement on every signer via the
   `operationNamedDefaults` helper or inline.
3. Add an orchestrator under `src/<operation>/<operation>-orchestrator.ts`
   (pure function for non-Angular consumers) and/or a sibling
   Angular `@Injectable` for Angular consumers. Export through
   `core.ts` + `index.ts`.
4. Per-signer specs pin the operation's invariants (positive-equality
   asserts on the wire-tx bytes); orchestrator spec proves the full
   build → sign → broadcast chain end-to-end.

**Legacy state:** the internal `signAndBroadcast` /
`signMultiInputAndBroadcast` / `signPsbtOnly` methods still exist on
each signer for the `operationNamedDefaults` delegation, and remain
on the `WalletSigner` interface for the delegation typing. The
`WalletSigner` interface itself is NOT re-exported through `core.ts`
or `index.ts`, so no public consumer can reach those methods. Future
passes can inline the delegation and drop the legacy methods
entirely from the interface.

## HARD RULE: cat UTXO size — set ONCE at mint (546), PRESERVED by every later operation

**A cat lives on a UTXO. That UTXO's size is set exactly ONCE — when the cat is
created — and is NEVER changed by any later operation.** Two ways a cat is
created: our **mint** creates a fresh cat at **546 sats** (`CAT21_POSTAGE_SATS`,
a conservative cross-address dust floor: taproot 330, segwit 294, p2sh 540; 546
clears them all); OR **any external tx** mints a cat at **any size**
(`nLockTime=21` on an any-size output — an inscription-with-nLockTime-21 carries
a cat on its own UTXO). After creation, **every operation that MOVES the cat
(transfer, offer/settle) PRESERVES the incoming cat UTXO's exact size**: output
0 = the incoming cat value, byte-for-byte. We do NOT resize, split, or
"normalise to 546" an existing cat — every sat on it travels together, intact,
under ordinal theory. **Resizing an existing cat UTXO, or rejecting one because
its value isn't 546, is a bug, not a rule.**

### The golden rules, per operation

| Operation | Output 0 (the cat) | Fee paid by | Change |
|---|---|---|---|
| **Mint** | **546** — fresh cat we create (nothing to preserve) | the funding input | `funding − 546 − fee`; dust-absorb |
| **Transfer** | **= `catUtxo.value`** — the WHOLE incoming UTXO, preserved | **separate funding input(s)**; the cat is never touched for the fee | `funding − fee`; dust-absorb |
| **Offer** | **= `sellerInput.value`** — the WHOLE seller UTXO, preserved (ord `wallet offer create` parity) | buyer funding | `buyerFunding − (price + V + fee)`; dust-absorb. Output 1 (seller payout) = `price + sellerInput.value` |

**Dust-absorb (identical for all three):** change ≥ its address's dust floor →
emit change back to us; sub-dust change → absorb into the miner fee (a tip),
tracked in each builder's `finalFeeSats`. This is the mint's long-standing "dust
is a feature" behaviour, now shared by transfer.

**Fee never shrinks the cat.** Transfer and offer pay the fee from SEPARATE
funding inputs; the cat UTXO passes straight through input 0 → output 0.
Transfer therefore REQUIRES funding to cover the fee (same as mint) — a cat on a
large UTXO cannot "self-fund" a transfer, because that would resize it.

**The accept-side offer validator** computes net-to-seller as `output1 −
sellerInputValue` and enforces only the price floor — never that the seller
input equals 546. It also does NOT pin output 0 to 546: it accepts any value
clearing that output address's dust floor, because a stock-ord `wallet offer
create` sets output 0 to the inscription's REAL postage (ord's own test at
`cat21-ord/tests/wallet/offer/create.rs` inscribes 9000 sats and asserts
`output[0].value == 9000`). Pinning 546 there would reject every valid ord-built
offer for an inscription-that-is-also-a-cat, breaking "buy an inscription from
stock ord".

**546 is never a DETECTION rule either.** Do NOT detect a cat by its UTXO
size: a 546-sat UTXO is not necessarily a cat (inscriptions and rare sats are
dust-postaged too), and a cat is not necessarily 546. Cat membership is
answered only by the cat index (cat21-ord `/address` → `cat_numbers`, i.e.
`catsAtAddress` / `addressHoldsCat`), never by a size heuristic. Watch-only
spendability likewise excludes cats AND inscriptions AND runes AND rare sats
via the full ord + cat21-ord (`classifyOutpoint` / `makeWatchOnlyProbe`),
never by size.

**Why FIFO is load-bearing**: ord assigns the cat to the first sat of the first
output (ordinal theory). The cat must be at input 0 and output 0 must be its
landing output, or the cat lands elsewhere silently. The builders enforce
input-0-is-cat and output-0-is-cat. Because output 0 = the whole cat UTXO
(transfer/offer) or 546 (mint), the cat's first sat always lands at output 0's
first sat.

**Where each rule lives (code):**
- `cat21-mint/cat21-mint.helper.ts`: mint output 0 = 546 (fresh); change `funding − 546 − fee`, dust-absorb, `finalFeeSats`.
- `cat21-transfer/cat21-transfer.helper.ts`: transfer output 0 = `catUtxo.value` (PRESERVE — never 546); fee from funding; change `funding − fee`, dust-absorb, `finalFeeSats`.
- `cat21-offer/cat21-offer.helper.ts`: offer output 0 = `sellerInput.value` (PRESERVE, ord parity); output 1 = `price + sellerInput.value`; validator nets `output1 − sellerInputValue`, gates output 0 only on the per-address dust floor. Proven at 546/3000/9000/30000 in `e2e/regtest/offer-ord-parity-sizes.spec.ts` against live `ord wallet offer create`.
- `CAT21_POSTAGE_SATS = 546` is used ONLY by the mint (fresh cat) + as a dust-floor fallback — never as a transfer/offer output size.

**Relation to ord:** offer + inscribe are cross-compat surfaces, byte-parity
with ord except `nLockTime=21`; ord's `wallet offer create` also preserves the
UTXO size (`output[0] = inscription.value`), so preserve = ord parity there.
Transfer has no counterparty, so it is NOT bound to ord's `wallet send` (which
resizes to a configurable postage, default 10000) — our stricter
preserve-the-exact-UTXO rule is intended. See HQ "cat-touching txs do exactly
what ord does".

**Every size test MUST stress non-546 sizes.** A 546-only parity/size test is a
happy-path test that proves nothing about size-handling.

## HARD RULE: CAT-21 mints — RBF policy (per-wallet)

**CAT-21 mint inputs carry a wallet-specific sequence number.**
The choice is anchored at PSBT-build time, not at signer time,
because the sequence is part of the bytes the wallet signs over —
choosing it later would invalidate the signature.

| Wallet | Sequence | RBF-signaling? | Why |
|---|---|---|---|
| **Cat21 Wallet** (`KnownOrdinalWalletType.cat21wallet`) | `0xfffffffd` | YES | OUR wallet. Knows about cats by construction. Its mempool-acceleration UI guarantees `nLockTime=21` is preserved on any RBF replacement (HARD RULE #1 in `cat21-wallet/CLAUDE.md` — `CAT21_MINT_INPUT_SEQUENCE` constant, replacement-construction asserts `lockTime === 21` before broadcast). RBF here is safe AND useful — users can bump fee in mempool congestion without rebuilding the mint. |
| **Everyone else** (Xverse, Unisat, Leather, OKX, Wizz, Phantom, Alby, …) | `0xfffffffe` | NO | Third-party wallets don't know about cats. If their UI offers "accelerate / replace with higher fee" on a CAT-21 mint, the replacement is built without `nLockTime=21` and the cat is burned. The 2024 Xverse incident is the lesson. Default policy: refuse to signal RBF so no external wallet ever offers to accelerate. |

**Number `21` is data, not a time-lock.** Block 21 was mined in
2009, so the `nLockTime=21` constraint is trivially satisfied no
matter when the tx lands. The field is misused as a protocol
marker — cat21-ord's filter reads it structurally
(`tx.nLockTime === 21` returns true → mint a cat) regardless of
whether Bitcoin consensus is actually enforcing the lockTime.
That means `0xfffffffe` (consensus enforces lockTime against the
already-long-past block 21) and `0xffffffff` (consensus IGNORES
the lockTime entirely but the field bytes are still there)
produce identical cat-mint outcomes. We pin `0xfffffffe` anyway
because it's the only non-RBF value that's behaviorally well-formed
(see [BIP-68 / BIP-65](https://github.com/bitcoin/bips)) — but
the cat would mint either way.

**The real protection is RBF signaling.** A wallet's
"accelerate / replace with higher fee" UI only fires on inputs
that signal RBF (sequence ≤ `0xfffffffd`). Default `0xfffffffe`
on every external wallet means none of their acceleration UIs
ever touch a CAT-21 mint — the cat cannot be killed by a fee-bump
flow because no fee-bump flow is offered. Cat21 Wallet IS allowed
to signal RBF because its acceleration code path is contractually
required to preserve `nLockTime=21` (cat21-wallet HARD RULE #1).

The rule is enforced at exactly ONE place:
`src/cat21-protocol/cat21-sequence.ts → resolveCat21MintInputSequence()`
(called from `buildCat21MintPsbt`). Don't duplicate the branch
elsewhere. If a future signer wants to override the sequence, it must
update this function, not work around it. A focused spec
(`cat21-sequence.spec.ts`) pins the per-wallet sequence value; touch
one without the other and CI
catches it.

**See also**: `cat21-wallet/CLAUDE.md` HARD RULE #1 (the wallet
side of the contract), `project_cat21_must_not_signal_rbf` memory
(the 2024 Xverse incident origin), `INTEGRATION-ORDPOOL-SDK.md` in
the cat21-wallet repo (provider discovery contract).

## What goes here vs. where

| Where it belongs | Pattern |
|---|---|
| **ordpool-parser** | Pure function, zero runtime deps, no I/O. Byte-twiddling, hex/base64, format detection, parsers, hash utilities. Anything that could run unchanged in a Cloudflare Worker or a fetch event handler. |
| **ordpool-sdk** | Higher-level domain code with a sane runtime dependency footprint OR networked / stateful logic. REST clients, calendar walkers, signing helpers, ordpool API wrappers. |
| **ordpool/frontend & ordpool/backend** | Anything that imports Angular, the mempool framework, or the upstream's internal types. |

When in doubt, ask: "could this be the basis for a standalone npm package, a CLI, or a GitHub Action?" If yes → parser or SDK. If it imports Angular or mempool internals → fork.

**No duplication.** If a primitive lives in the parser already, the SDK imports it. The SDK declares `ordpool-parser` as a runtime dependency via the same `github:` shorthand the rest of the org uses (no npm publish involved). Do not copy parser code into the SDK.

## Consumer wiring

There is no npm publish for this package. Consumers pin a git SHA:

```jsonc
// In the consumer's package.json:
"ordpool-sdk": "github:ordpool-space/ordpool-sdk#<sha>"
```

## Shipped artifacts

Split posture:

  - **`dist/`** (Angular ng-packagr fesm2022 bundle) — **checked
    in to git**. Every commit on `main` ships with the pre-built
    Angular bundle.
  - **`dist-core/`** (plain TS/ESM core entry, CommonJS) — **NOT
    checked in**. Regenerated at consumer-install time by the
    `prepare` script (`npm run build:core`, plain tsc — unaffected
    by the ng-packagr-in-node_modules bug).

Why the split:

1. ng-packagr's tsc has an unresolved bug: run from inside a
   parent's `node_modules/`, it emits incomplete tmp-typings and
   fails with `Could not resolve "./cat21-protocol" from
   dist/tmp-typings/index.d.ts`. Same directory copied to `/tmp`
   builds clean. Root cause unknown. So `build:angular` genuinely
   cannot run in the prepare hook — the Angular bundle has to ship
   pre-built in git.
2. `build:core` (plain tsc, no ng-packagr) DOES work from inside
   `node_modules/`. So the Angular-free entry can be prepared at
   install time and doesn't need to pollute git with dist churn.

Consumer contract:

  - **Angular consumers** (ordpool/frontend, cat21-indexer/frontend)
    import from `ordpool-sdk` (main entry, `dist/`). The shipped
    tarball bytes are what they get.
  - **Non-Angular consumers** (cat21-wallet, cat21.space core code)
    import from `ordpool-sdk/core` (`dist-core/`), which the
    `prepare` script generates at install time. Install scripts
    must be enabled for this to work — in this workspace they are:
    `/Work/ordpool/.npmrc` sets `ignore-scripts=false` for every
    project below it (the old global `ignore-scripts=true` posture
    was retired 2026-07-17 and the global `~/.npmrc` deleted). If
    `dist-core/` is missing after an install, the script didn't
    run — check `npm config get ignore-scripts` resolves to
    `false` from the consumer's directory.

Trade-off accepted: install scripts running means Shai-Hulud-class
attack surface across the dep tree (npm has no per-package script
whitelist). The mitigation is lockfile discipline, not script
blocking — see the workspace `CLAUDE.md` "Local npm setup" section
and the header comment in `/Work/ordpool/.npmrc`.

## HARD RULE: build before commit

When you change any source file under `src/`, you MUST run
`npm run build:angular` and commit the regenerated `dist/`
alongside the source change in the same commit. `dist-core/` is
generated per-install by the `prepare` hook — do not commit it.

Reason: consumers pin SHAs. If you push source-only, the next
Angular consumer install pulls the STALE `dist/` from the tarball
and runs the old behaviour silently.

The CI workflow re-verifies this invariant: every push runs
`npm run build:angular` and `git diff --exit-code dist/` — if the
committed `dist/` doesn't match a fresh build, the push fails.

To ship a change to a consumer:

1. Edit `src/`.
2. `npm run build:angular` (regenerates `dist/`).
3. `npm test` (node + browser unit tests).
4. `git add src/ dist/` + commit + push to `main`. **DO NOT** add
   `dist-core/` — it's gitignored.
5. In the consumer: bump the SHA in `package.json`, run
   `npm install --package-lock-only ordpool-sdk@github:ordpool-space/ordpool-sdk#<sha>`
   to update the lockfile, commit BOTH `package.json` and
   `package-lock.json` together (CI caches node_modules by
   lockfile hash; a stale lockfile masks the bump).

For live local development (no commit needed), `npm link` still
works — the consumer's link target is the locally-built `dist/`
or `dist-core/`. Faster iteration than rebuilding + committing
every keystroke. Just remember to `npm run build` in the SDK
between iterations.

## Commands

```bash
npm test                    # node + browser test suites
npm run test:node           # node tests only
npm run test:browser        # jsdom browser tests only
npm run build               # Angular fesm2022 + plain TS/ESM core
npm run build:angular       # ng-packagr → dist/ only
npm run build:core          # tsc → dist-core/ only
npm run clean               # rimraf dist/ dist-core/
npm run create-link         # build + npm link (for local dev consumers)
```

## Code conventions

- **TypeScript strict mode.** No `any`.
- **`Uint8Array`, not Node `Buffer`.** Same browser-compatibility rule as the parser. `Buffer` is acceptable in test code only.
- **Pure functions preferred.** No dependency injection containers, no class-based state where a function would do. The SDK has side effects (it talks to networks), but compose them at the entry point; keep the core pure.
- **`ArrayBuffer.isView(x)`** not `x instanceof Uint8Array` for binary-data type guards. Cross-realm safety.
- **`TextEncoder` / `TextDecoder`** for string encoding.
- **`fetch` + `AbortController`** for HTTP. Never `axios`. The same headquarter HARD RULE applies here.
- **Behaviour-only comments.** Describe what the code does now, not its history. Regression-pinning tests are the one allowed exception (a one-line note about the bad input is fine there). See the top-level CLAUDE.md "Production code describes what it does, not its past" rule.

## Testing

- Jest, both `node` and `jsdom` environments, same dual-config pattern as the parser.
- **Real data over fixtures.** When testing anything that talks to a Bitcoin endpoint (REST wrapper, calendar client, signing helper), use real responses from real mainnet endpoints. Synthetic fixtures hide protocol mismatches.
- **Exact assertions, not ranges.** `toBe(9925)`, not `toBeGreaterThan(0)`. Same rule as the parser — see its `.claude/CLAUDE.md` for the full rationale.

## Architecture

`src/` is currently empty. Modules will land as concrete needs surface. The layout will mirror the parser's pattern: one directory per domain area, service-named files (`xxx-client.service.ts`, `xxx-client.service.helper.ts`, co-located specs).

## Public API

`src/index.ts` is the single export point. Every module that consumers should use re-exports through `src/index.ts`. Anything not in `src/index.ts` is treated as internal.

## Wallet integration: Adapter Pipeline (A) vs Wallet Pipeline (B)

Every wallet (Xverse, Unisat, Leather, …) has two parallel test
pipelines, with different blast radii and different questions:

- **Adapter Pipeline (A)** — pins *our* adapter code against a
  mocked wallet API. Lives in `src/wallet/signers/*.signer.ts` +
  `*.signer.angular.spec.ts` and `src/wallet/connectors/`. Runs via
  `npm test`, no binaries, fast. Done when every adapter call path
  (happy + every distinct failure mode) is pinned by a positive-
  equality unit test.
- **Wallet Pipeline (B)** — pins *the real wallet's contract*
  using the published .crx running headed in xvfb. Lives in
  `e2e/playwright/specs/<wallet>-*.spec.ts`. CI-only — never run
  unverified extension binaries on a dev machine. Iteration ladder:
  loads → onboard → SDK-handshake → matrix → mint roundtrip.

  General Playwright rules (data-testid first, click instead of
  `goto`, wait on states, ordpool-specific regtest bootstrap +
  wallet-load pattern) live at workspace root:
  `~/Work/ordpool/E2E_BEST_PRACTICES.md`. Read it before touching
  any spec.

## HARD RULE: CI is the test. No manual smoke.

The maintainer is Bitcoin-poor and will not install wallets +
fund them with real BTC to "smoke-test" each release. CI
simulates the entire flow against regtest (`e2e/docker-compose
.regtest.yml`: bitcoind + electrs, headed Chromium + the real
extension `.crx` under xvfb), which is exactly the point.

CI is a verification tool, not a release gate. Pipeline B
gives us evidence about whether a real wallet binary plays
along with our adapter; that evidence shapes documentation
and skip-comments but it does NOT decide what ships in the
public API.

## HARD RULE: Ship every signer we have code for

`walletSigners` (`src/wallet/signers/index.ts`) contains every
WalletSigner file in the directory, period. No second-gate
filtering on top of detect-by-signature.

Reasoning: detect-by-signature already gates surface
visibility. If `window.<wallet>` isn't present at runtime,
the wallet picker never offers that option, the user never
clicks "sign with X," and the signer never gets called. The
registry's only job is to give us the call shape WHEN detect
succeeds. Withholding signer code from the registry doesn't
prevent bugs — it just prevents users from exercising the
code and giving us real-world feedback.

This means:
- Phantom signer ships even though the v26.x desktop binary
  ships btc.js dormant. Mobile users on Phantom's in-app
  browser have `window.phantom.bitcoin` per the docs; they
  get the signer. Desktop users don't see Phantom in the
  picker because detect returns false.
- Alby signer ships even though we don't have an Alby Hub
  in CI to drive a mint-roundtrip. Users with a real Alby
  Hub backend get the signer; users without get a clean
  runtime error from the wallet.

Pipeline B gaps get documented as known-caveats in the
signer file's docstring, NOT as registry exclusions.

Goal: complete signer coverage in the published API. Real
user signal is the missing piece, not a stricter gate.

Full definitions, iteration ladder, and bootstrap/caching procedure
in `/Work/ordpool/WALLETS.md` (the workspace HQ). Read it before
starting work on a new wallet.

## HARD RULE: Offers are public; share them anywhere

**A CAT-21 buy-offer PSBT is not secret. There is no need to "protect"
or "hide" it.** Any channel works — URL query parameter, copy-pasted
text in a Discord channel, a tweet, an email, a QR code on a poster, a
file attachment. Every distribution channel is fine.

Reasoning, in priority order:

1. **The offer reveals nothing that won't land on Bitcoin anyway.** A
   buy-offer PSBT encodes: which cat UTXO is for sale, the asking price
   in sats, the seller's payout address, `lockTime=21`. The instant the
   offer is accepted and broadcast, every one of those facts is on a
   public blockchain forever. A leaked offer that never gets accepted
   leaks nothing — it's a price quote tied to a cat, both already
   visible to anyone scanning the chain.
2. **It's only useful to a willing buyer.** A buy-offer PSBT, by
   construction, requires the buyer's funding inputs + the buyer's
   change output + the buyer's signatures (SIGHASH_ALL on every buyer
   input). A third party who picks the PSBT off a wire cannot accept
   it without spending their own UTXOs at the seller's price. The
   worst-case "leak" outcome is the same as the intended outcome: the
   recipient (or some other willing buyer) accepts the offer at the
   stated price. The seller's interest is *more* visibility, not less.
3. **Sniping-proofness is structural, not transport-secrecy.** The
   PSBT is sniping-proof because once the seller's signature lands,
   every byte is committed by SIGHASH_ALL signatures (see
   `buildCat21BuyOfferPsbt`). No partial-PSBT splicing is possible.
   Transport-layer obfuscation (URL fragments, base64-only artifacts,
   non-indexable hosting) adds nothing on top of this and creates
   friction for legitimate distribution.

**Consumer guidance for the SDK's offer flow:**

- The artifact is bare base64 of the unsigned-by-buyer PSBT. Wrap it in
  whatever transport the consumer wants. Query params (`?accept=…`),
  fragments (`#…`), plain text in a textarea, QR code, signed message,
  IPFS pin, GitHub gist — all equivalent from a security perspective.
- Consumers MAY add cosmetic discovery aids (a hash-fragment so a
  click-to-buy link works without a server round-trip; a copy-to-
  clipboard button; a QR rendering). They MUST NOT design around an
  "offers are leaked" threat model. There is no such threat.
- If a UI surface chooses one channel for default rendering, don't
  hand-wave about "for privacy" or "to avoid server logs". The right
  framing is **"this is the most ergonomic for the average user"** —
  not security.

Workspace HQ carries the same rule (search "Offers can be shared in
the wild" in `/Work/ordpool/CLAUDE.md`) so the cat21-indexer / ordpool
consumer guides stay aligned.

## HARD RULE: Never derive a payment address from an on-chain lookup

**The seller's PAYMENT address is knowable only from the seller's own
wallet.** It is NEVER derivable from an on-chain ownership lookup, an
inscription-owner query, an ord `/output/*` response, an electrs
`/address/*/utxo` listing, or any other on-chain source.

Why: cats live on the seller's ORDINALS address per ordinal theory.
Any on-chain query "who owns cat #N" returns the ordinals-context
address. Treating that string as a payment address does two categories
of damage:

1. **Address-type mismatch on the offer path.** The buyer builds the
   offer's payment output routed to the seller's ordinals address; the
   seller's accept-side validator expects the payment output at their
   wallet's `paymentAddress`. Validator returns `payment-output-wrong-
   address`. Sign button never enables. Trade fails silently. Even if
   the two happened to match (single-address wallets), the payment
   would land at the ordinals address, contaminating the seller's
   ordinal-safety accounting.

2. **Wallet contamination on any future flow that consumes the
   auto-filled value.** A payment address used for spendable BTC and
   an ordinals address used for immovable NFT UTXOs are semantically
   different categories. Every place that mixes them creates a future
   burn opportunity.

**The correct flow for cat21 permalinks** (implemented in
`src/cat21-share/permalink.helper.ts`):

- **Seller's device** (sell modal): read `wallet.paymentAddress` from
  the connected wallet at modal-open time. Include as `payTo=<addr>`
  in the ask permalink.
- **Buyer's device** (make-offer): parse `sellerPaymentAddress` from
  the URL via `parseBuyOfferQueryParams`. If missing, leave the form
  field EMPTY with a copy prompt ("ask the seller for their payment
  address"). NEVER auto-fill from any on-chain lookup.
- **Any other future flow** that needs the seller's payment address:
  same rule. Carry it in the URL, ask the user, or take it from the
  connected wallet. Do NOT derive it.

**How this rule applies beyond cat21 permalinks:**

- Transfer recipient addresses: user-supplied (typed / pasted).
- Buyer receive address: from the buyer's connected wallet
  (`wallet.ordinalsAddress` — because cats land at ordinals).
- Seller change addresses (offer flow): from the seller's connected
  wallet (`wallet.paymentAddress`).
- Any address that will EVER be spent from, funded to, or checked
  against a signing key: comes from a wallet, not from a chain lookup.

**Prevention going forward.** If you catch yourself writing a line
like `orchestrator.setSellerPaymentAddress(ord.address)` or
`payTo: catOwner`, stop. Trace where that address value originated.
If it came from an ord / electrs / inscription-owner query, you're
about to reproduce this bug. Route the address through the URL
permalink or the connected wallet instead. When in doubt, brand the
type: `type OrdinalsAddress = string & { __ord: never }` vs `type
PaymentAddress = string & { __pay: never }` and the compiler catches
the miscast.

Illustrative incident: 2026-07-18 in `cat21-indexer/frontend/src/app/
dashboard/trade/make-offer/make-offer.ts` — `resolvedSellerAddress`
was set from `CatUtxoLookupService.getTargetByNumber(n)`'s
`.sellerAddress` (an on-chain ord lookup returning the ordinals
address), then piped into `orchestrator.setSellerPaymentAddress(...)`
as if it were the payment address. Every URL-driven accept on
Xverse/Leather/OKX broke silently. Fix: sellerPaymentAddress now
travels in the ask permalink via `payTo=` (encoded on the seller's
device where the paymentAddress is knowable), parsed on the buyer's
side via `parseBuyOfferQueryParams(query).sellerPaymentAddress`.
