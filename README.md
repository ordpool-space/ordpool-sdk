# ordpool-sdk

Higher-level Bitcoin / Ordinals SDK for the [ordpool](https://ordpool.space)
ecosystem. Sits one layer up from
[`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser):
the parser pulls artifacts (inscriptions, runes, BRC-20, SRC-20,
CAT-21, Atomicals, Labitbu, OpenTimestamps) out of raw transactions;
**ordpool-sdk** is the domain layer on top — networking, signing,
REST wrappers, marketplace flows.

MIT-licensed. Works in Node.js and browsers. No npm publish;
consumers pin a git SHA:

```jsonc
"ordpool-sdk": "github:ordpool-space/ordpool-sdk#<sha>"
```

The `prepare` lifecycle script builds `dist/` automatically when a
git ref is installed.

## What's in it

- CAT-21 mint, transfer, buy-offer, accept-offer flows — PSBT
  builders + validators that emit ord-compatible bytes.
- Multi-wallet picker + per-wallet signer adapters. Detection is
  signature-based: only wallets whose `window.<wallet>` surface
  is live at runtime show up.
- Broadcast dispatcher (Bitcoin mempool + miner-direct fallback for
  oversize / non-standard txs).
- Network helpers (`Network` enum, address-network detection for
  wrong-network red banners).
- Watch-only signing path via the BIP-174 PSBT-export round-trip,
  so any conformant external signer plugs in.

The CAT-21 cat-flow code is the heart of it. Consumers either drive
the orchestrators end-to-end (cat21.space) or pick the pure
helpers they need (cat21-wallet, autonomous bots, third-party
integrations).

## Consumers

- **cat21.space** — mint + offer UI, wallet picker, cat21-ord
  API client.
- **cat21-wallet** (Chrome extension, ordpool-space/cat21-wallet)
  — uses the SDK's pure helpers; the wallet owns no PSBT
  construction logic.
- **autonomous bots** — broadcast dispatcher + the per-wallet
  signer for whichever wallet the operator wired up.

Any consumer can take any subset without pulling framework deps:
pure functions return plain data, network calls take a
`fetchImpl`, signing is decoupled from broadcast.

## Public API

`src/index.ts` is the single export point. Everything else is
internal. Read the source for the current shape; the surface is
intentionally minimal and additive.

## Wallet support

| Wallet | Status |
|---|---|
| Cat21 Wallet | Our own wallet (ordpool-space/cat21-wallet) |
| Xverse, Leather, Unisat, Wizz, OKX, Alby | Connector + signer ship; detection gates picker visibility |
| Watch-only (Sparrow, Electrum, Coldcard, Ledger, Trezor, Specter, Bitcoin Core) | Via PSBT export round-trip |

Wallets without a runtime surface simply don't appear in the
picker. The same registry serves every consumer.

## Code conventions

- TypeScript strict mode. No `any`.
- `Uint8Array`, not Node `Buffer`. Same browser-compat rule as the
  parser.
- `ArrayBuffer.isView(x)` not `x instanceof Uint8Array` for
  binary-data type guards.
- `TextEncoder` / `TextDecoder` for string encoding.
- `fetch + AbortController` for HTTP. **Never axios.**
- Pure functions preferred. The SDK has side effects (it talks to
  networks) but compose them at entry points; keep the core pure.
- Behaviour-only comments. Describe what the code does NOW.
  Regression-pinning tests are the one allowed exception.

## Testing

- Jest, dual config: `npm run test:node` + `npm run test:browser`.
- Real responses from real mainnet endpoints where the test
  exercises an endpoint. Synthetic fixtures hide protocol
  mismatches.
- Exact assertions, not ranges. `toBe(9925)`, not
  `toBeGreaterThan(0)`.

## Commands

```bash
npm install                 # also runs `prepare` → builds dist/
npm test                    # node + browser test suites
npm run test:node           # node tests only
npm run test:browser        # jsdom browser tests only
npm run build               # plain tsc: ESM main + CJS core + e2e
```

## Why two packages

Three TypeScript codebases we own:

- [`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser)
  — zero deps, pure functions, runs anywhere.
- [`ordpool-sdk`](https://github.com/ordpool-space/ordpool-sdk) —
  domain code with deps and side effects.
- `ordpool/frontend` + `ordpool/backend` — forked from mempool.

Reusable helpers (CLI, GitHub Action, third-party integration) go
in the parser (pure) or the SDK (networked).

## Status

API is stable. New consumer integrations welcome — file an
[issue](https://github.com/ordpool-space/ordpool-sdk/issues) if
you need a missing piece.

## License

MIT
