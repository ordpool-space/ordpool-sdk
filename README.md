# ordpool-sdk

Higher-level Bitcoin / Ordinals SDK for the [ordpool](https://ordpool.space) ecosystem.

[`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser) reads raw transactions and pulls out the artifacts inside (inscriptions, runes, BRC-20, SRC-20, CAT-21, Atomicals, Labitbu, OpenTimestamps). **ordpool-sdk** is everything one layer up from that — domain code that talks to networks, signs things, walks calendars, wraps third-party REST APIs. It's the place for code that doesn't fit the parser's zero-dependency, pure-function constraint.

MIT-licensed, works in Node.js and browsers.

```
npm install github:ordpool-space/ordpool-sdk
```

## Status

Early scaffold. Public API surface is intentionally empty for now — modules will land as concrete needs surface (calendar clients, signing helpers, etc.). The repository is here so we have a place to put things in the right home from day one, rather than letting domain code drift into the parser or into the mempool fork.

## Wallet support

Detection is signature-based: whatever exposes the expected `window.<wallet>` global at runtime surfaces in the picker, whatever doesn't isn't shown.

| Wallet | Connect + sign tested against real binary in CI? |
|---|---|
| Xverse | ✅ |
| Leather | ✅ |
| Unisat | ✅ |
| Wizz | ✅ (P2WPKH path; P2TR matrix needs the wallet's CDN we can't reach from CI) |
| OKX | ✅ |
| Oyl | ✅ |
| Alby | partial — loads / onboard / handshake / getAddress green; mint roundtrip blocked at signPsbt step (Alby's SW signer never returns from the Confirm popup; see `alby-mint-roundtrip.spec.ts` for the full investigation) |
| Phantom | **Untested — see note below** |
| Binance Wallet | **Untested — see note below** |
| Watch-only (xpub) | ✅ (Sparrow, Electrum, Coldcard, Ledger, Trezor, Specter, Bitcoin Core via PSBT paste) |

### Potentially supported, untested

Two wallets ship connector + signer code matched against their official developer documentation but cannot currently be exercised end-to-end:

- **Phantom**. Per [Phantom's own Help Center](https://help.phantom.com/hc/en-us/articles/29995498642195-Connect-Phantom-to-an-app-or-site): *"Phantom does not support connecting to dApps on Bitcoin."* Disassembly of the v26.14.0 + v26.16.0 desktop binaries confirms `btc.js` ships but is never auto-registered as a content script and the service worker has no `btc_*` method handlers. Detect-by-signature returns false on current desktop builds, so Phantom doesn't surface in the picker for desktop users. Mobile in-app browser is [documented](https://docs.phantom.com/bitcoin/sending-a-transaction) to expose `window.phantom.bitcoin`; if/when it does, this SDK's existing connector + signer light up automatically with no code changes.

- **Binance Wallet**. The [official developer docs](https://developers.binance.com/docs/binance-w3w/bitcoin-provider) document `window.binancew3w.bitcoin` with `requestAccounts` / `getPublicKey` / `signPsbt` / `signMessage` / etc. Disassembly of v1.17.2 (current Chrome Web Store) shows the binary injects `window.binancew3w.{wallet, ethereum, solana, tron, sui, tonconnect}` — the `.bitcoin` namespace is documented but not actually shipped. Same situation as Phantom: detect returns false, wallet doesn't surface, signer ready to activate the moment Binance enables the documented API.

Adapter shape for Binance is matched against [LaserEyes' production-deployed `binance.ts` provider](https://github.com/omnisat/lasereyes-mono/blob/main/packages/core/src/client/providers/binance.ts), which is used by multiple Ordinals integrations.

If you're integrating against ordpool-sdk and care about either wallet: the code paths exist and are exported; please [file an issue](https://github.com/ordpool-space/ordpool-sdk/issues) if you encounter a real wallet build that exposes the surface and the adapter doesn't work as expected.

## Why two packages

We own three TypeScript codebases:

- [`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser) — zero runtime dependencies, pure functions, runs anywhere.
- [`ordpool-sdk`](https://github.com/ordpool-space/ordpool-sdk) — higher-level domain code that can have dependencies and side effects.
- `ordpool/frontend` and `ordpool/backend` — forked from mempool.

Helpers that should be reusable from a CLI, GitHub Action, third-party app, or another ecosystem repo belong in the parser or the SDK depending on shape (pure-function vs. networked).

## License

MIT
