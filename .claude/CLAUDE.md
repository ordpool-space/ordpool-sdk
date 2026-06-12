# CLAUDE.md

## Overview

**ordpool-sdk** is the higher-level domain library for the ordpool ecosystem. It sits one layer above [`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser): the parser extracts artifacts from raw transactions; the SDK does everything one step up from that — REST wrappers, calendar clients, signing helpers, anything that needs to talk to a network or hold side-effecting logic.

- **MIT licensed.**
- **Dual output**: ESM (`dist/`) and CommonJS (`dist-commonjs/`).
- Works in Node.js AND browsers.
- No external consumers yet — only `ordpool.space` and `cat21.space` will use it. No CHANGELOG, no semver gymnastics.

## HARD RULE: Keep useful comments

**Don't strip JSDoc or "why" inline comments under the banner of
"simplification".** The text inside a comment can be trimmed (no
bombast, no LLM-speak, no before-after history); the block itself
stays. Wallet quirks, coin-selection rationale, and signing-flow
edge cases are exactly the kind of comment a future reader cannot
reconstruct from code alone. Full decision tree in the workspace
`CLAUDE.md` HARD RULE "Keep useful comments (JSDoc AND inline 'why')".

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

The `prepare` script in `package.json` runs `npm run build` automatically when a git ref is installed, so the consumer gets a fully-built `dist/` and `dist-commonjs/` without any extra step.

To ship a change to a consumer:
1. Commit + push to `main`.
2. Bump the SHA in the consumer's `package.json`.
3. `npm install` in the consumer (regenerates lockfile).
4. Commit BOTH `package.json` and `package-lock.json` together — CI caches `node_modules` by lockfile hash, and a stale lockfile makes the cache restore the wrong build.

For live local development (no commit needed):
```bash
# In ordpool-sdk/
npm run build && cd dist && npm link

# In the consumer (e.g. ordpool/frontend/)
npm link ordpool-sdk
```

## Commands

```bash
npm install                 # also runs `prepare` → builds dist/ + dist-commonjs/
npm test                    # node + browser test suites
npm run test:node           # node tests only
npm run test:browser        # jsdom browser tests only
npm run build               # ESM + CommonJS, one tsc invocation each
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
