# ordpool-sdk

Higher-level Bitcoin / Ordinals SDK for the [ordpool](https://ordpool.space)
ecosystem. Sits one layer up from
[`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser): the
parser reads raw transactions and pulls out the artifacts inside
(inscriptions, runes, BRC-20, SRC-20, CAT-21, Atomicals, Labitbu,
OpenTimestamps). **ordpool-sdk** is everything one layer up — domain
code that talks to networks, signs things, walks calendars, wraps
third-party REST APIs.

MIT-licensed. Works in Node.js and browsers. No npm publish; consumers
pin a git SHA:

```jsonc
"ordpool-sdk": "github:ordpool-space/ordpool-sdk#<sha>"
```

The `prepare` lifecycle script builds `dist/` automatically when a git
ref is installed.

## Consumers

The SDK is built around two primary consumer profiles:

| Consumer | What they need from the SDK |
|---|---|
| **cat21.space** (Angular 21 site) | Mint flow (build PSBT → ask wallet to sign → broadcast), offer flow (build buy-offer PSBT, validate inbound offers), wallet picker + per-wallet signer quirks, cat21-ord API client |
| **cat21-wallet** (Chrome extension) | Lightweight: cat21-offer **validator** as defence-in-depth before signPsbt user prompt. The wallet does NOT build mint/offer PSBTs — those come from the SDK via signPsbt RPC. |
| **autonomous bots** (CLI / Discord / Twitter) | Agent-mode policy gate, broadcast dispatcher (Slipstream fallback), per-wallet signer for whichever wallet the operator wired up |

The API is designed so any of these can consume any subset without
pulling in framework dependencies they don't want — pure functions
return plain data, network calls take a `fetchImpl` for environments
that don't have a global fetch, signing is decoupled from broadcast.

## Public API surface

Each top-level directory under `src/` is its own module. `src/index.ts`
is the single export point; everything not re-exported through there is
internal.

### `src/cat21-mint/` — mint pipeline

- `cat21.service.helper.ts` — `createInput()` (per-wallet sequence: cat21wallet → 0xfffffffd RBF-signaling, every other wallet → 0xfffffffe non-RBF; both keep lockTime enforced); `createTransaction()` (lockTime=21 hardcoded); per-wallet input scripts for Xverse, Leather, Unisat.
- `cat21.service.ts` — top-level orchestration: build, simulate, broadcast.
- `cat21-mint-orchestrator.service.ts` — state machine for cat21.space UI: `idle` → `minting` → `success` / `error`.
- `cat21-api.service.ts` — REST wrapper to the cat21 backend.
- `utxo-content-scanner.service.ts` — scans UTXOs for cat-bearing outputs.

See `cat21-mint/README.md` (if present) for deeper notes; the
canonical safety invariants live in `.claude/CLAUDE.md` HARD RULE
"CAT-21 mints — RBF policy (per-wallet)".

### `src/cat21-offer/` — ord-style buyer-initiated offers (NEW)

Sniping-proof by construction: every input carries SIGHASH_ALL so the
seller's signature, once added, commits to every byte of the
transaction.

**API:**

```ts
import {
  buildCat21BuyOfferPsbt,
  validateCat21BuyOfferPsbt,
  CAT21_OFFER_POSTAGE_SATS,
} from 'ordpool-sdk';

// Buyer-side: construct an offer the seller can accept by signing input 0.
const offer = buildCat21BuyOfferPsbt({
  network: Network.Mainnet,
  sellerInput: { txid, vout, value: 546, scriptPubKey },
  buyerInputs: [{ txid, vout, value: 50_000, scriptPubKey }],
  destinations: {
    buyerReceiveAddress: 'bc1q...',     // cat lands here
    sellerPaymentAddress: 'bc1q...',    // BTC payment goes here
    buyerChangeAddress: 'bc1q...',
  },
  priceSats: 21_000,
  feeSats: 1_000,
});
// → offer.psbt is the unsigned PSBT to hand to the buyer's wallet.

// Seller-side: validate an inbound offer before signing.
const verdict = validateCat21BuyOfferPsbt({
  psbt: incomingOfferBytes,
  expectedSellerUtxo: { txid, vout },
  floorPriceSats: 21_000,
});
if (verdict.ok) {
  // ask wallet to sign input 0, broadcast
} else {
  console.warn(verdict.reason, verdict.detail); // typed rejection
}
```

**Validator rejection reasons** (`Cat21OfferRejectionReason`):

- `missing-seller-input` — input 0 doesn't reference the expected UTXO.
- `missing-seller-payment-output` — fewer than 2 outputs.
- `wrong-postage` — output 0 below configured minimum.
- `wrong-price` — output 1 below floor price.
- `sighash-not-all` — any input uses a sighashType other than ALL.
- `buyer-input-unsigned` — any input 1..N carries no signature.

**Defence-in-depth pattern (cat21-wallet integration):** the wallet
runs `validateCat21BuyOfferPsbt` before showing the signPsbt
confirmation. If validation fails, the wallet refuses to sign and
surfaces the typed reason to the user. The SDK builds + validates; the
wallet validates again as a paranoia check.

### `src/cat21-broadcast/` — mempool / Slipstream dispatcher (NEW)

```ts
import {
  decideBroadcastChannel,
  broadcastCat21,
  submitToSlipstream,
  STANDARD_TX_WEIGHT_LIMIT,
} from 'ordpool-sdk';

// Decision-only (for UI preview):
const decision = decideBroadcastChannel({ hex, weight });
// → { channel: 'mempool' | 'slipstream', reason }

// Actual broadcast:
const result = await broadcastCat21(
  { hex: signedTxHex, weight: txWeight },
  // Caller's mempool-broadcast callback. SDK stays decoupled from
  // mempool.space / blockstream.info / electrs — pass whichever you use.
  async (hex) => {
    const res = await fetch('https://mempool.space/api/tx', { method: 'POST', body: hex });
    return res.text(); // txid
  },
  {
    slipstreamBaseUrl: 'https://miner.example.com', // optional override
    signal: abortController.signal,                  // optional cancel
  }
);
// → { txid, channel }
```

Slipstream client is also exposed directly:

```ts
const { txid } = await submitToSlipstream(rawTxHex, {
  baseUrl: SLIPSTREAM_DEFAULT_BASE_URL,
  signal,
  fetchImpl, // optional, for environments without a global fetch
});
```

**No auto-retry across channels.** If Slipstream rejects, the caller
decides whether to fall back to mempool (which may reject for the same
standardness reason). This is the caller's policy, not the SDK's.

### `src/agent-mode/` — autonomous-action policy gate (NEW)

Pure-functional. Every autonomous mint / buy / sell-accept passes
through this gate before the agent constructs a PSBT.

```ts
import { evaluateAgentPolicy, AgentPolicy, AgentActionContext } from 'ordpool-sdk';

const policy: AgentPolicy = {
  enabled: true,
  maxSpendPerActionSats: 100_000,
  dailyCapSats: 500_000,
  maxFeeRateSatPerVbyte: 50,
  floorPriceSatsPerCat: 21_000,
  allowedCounterparties: ['bc1qmytrustedseller', 'bc1qmyfriend'],
};

const action: AgentActionContext = {
  kind: 'buy',
  spendSats: 21_000,
  feeRateSatPerVbyte: 12,
  counterpartyAddress: 'bc1qmytrustedseller',
  spentTodaySats: 0, // caller tracks running total
};

const decision = evaluateAgentPolicy(policy, action);
if (decision.allowed) {
  // build PSBT, ask wallet to sign, broadcast
} else {
  console.warn(decision.reason, decision.detail);
  // 'agent-disabled' | 'spend-above-action-cap' | 'spend-above-daily-cap'
  // | 'fee-rate-above-ceiling' | 'price-below-floor' | 'counterparty-not-allowed'
}
```

Order of checks: `enabled` → per-action cap → daily cap → fee rate →
floor price (sell-accept only) → counterparty. Cheapest first so the
gate fails fast on trivially blocked actions.

**The SDK is stateless.** The caller tracks `spentTodaySats` itself
(local storage in a browser, a SQLite file for a bot). The SDK
evaluates the policy without persistence.

### `src/wallet/` — wallet picker + signer adapters

- `signers/*.signer.ts` — per-wallet adapter (Xverse, Leather, Unisat,
  OKX, Oyl, Wizz, Phantom, Alby, Binance, Cat21Wallet). Detect by
  signature; only wallets whose `window.<wallet>` is live at runtime
  surface in the picker.
- `connectors/` — wallet-side connect-flow handling.
- `wallet.service.ts` — top-level wallet API.
- `psbt-extract.ts` — pull signed input data out of a returned PSBT.

### Other

- `network.ts` — `Network` enum (Mainnet / Testnet3 / Testnet4 / Signet
  / Regtest) and conversion helpers (`toScureNetwork`,
  `toBitcoinNetworkType`, `toLeatherNetworkString`).
- `network-token.ts` — currency / asset constants.
- `storage-like.ts` — minimal interface so callers can plug
  localStorage, AsyncStorage, an in-memory map, etc.

## Status

Public API surfaces are wired up and tested. New consumer integrations
(beyond cat21.space and cat21-wallet) are welcome; file an issue if
you need a missing piece or a new wallet adapter.

## Wallet support

Detection is signature-based: whatever exposes the expected
`window.<wallet>` global at runtime surfaces in the picker, whatever
doesn't isn't shown.

| Wallet | Connect + sign tested against real binary in CI? |
|---|---|
| Cat21 Wallet | ✅ (our own wallet — ordpool-space/cat21-wallet, forked from Leather; canonical `window.Cat21Provider` slot with politeness model for co-installation with real Leather) |
| Xverse | ✅ |
| Leather | ✅ |
| Unisat | ✅ |
| Wizz | ✅ (P2WPKH path; P2TR matrix needs the wallet's CDN we can't reach from CI) |
| OKX | ✅ |
| Oyl | ✅ |
| Alby | ✅ (full mint roundtrip — see `alby-mint-roundtrip.spec.ts` for the workaround: bypass Alby's confirm-popup UI by hitting the internal `webbtc/signPsbt` SW route directly from an extension-origin page) |
| Phantom | **Untested — see note below** |
| Binance Wallet | **Untested — see note below** |
| Watch-only (xpub) | ✅ (Sparrow, Electrum, Coldcard, Ledger, Trezor, Specter, Bitcoin Core via PSBT paste) |

### Potentially supported, untested

Two wallets ship connector + signer code matched against their
official developer documentation but cannot currently be exercised
end-to-end:

- **Phantom**. Per
  [Phantom's own Help Center](https://help.phantom.com/hc/en-us/articles/29995498642195-Connect-Phantom-to-an-app-or-site):
  *"Phantom does not support connecting to dApps on Bitcoin."*
  Disassembly of the v26.14.0 + v26.16.0 desktop binaries confirms
  `btc.js` ships but is never auto-registered as a content script and
  the service worker has no `btc_*` method handlers. Detect-by-signature
  returns false on current desktop builds, so Phantom doesn't surface in
  the picker for desktop users. Mobile in-app browser is
  [documented](https://docs.phantom.com/bitcoin/sending-a-transaction)
  to expose `window.phantom.bitcoin`; if/when it does, this SDK's
  existing connector + signer light up automatically with no code
  changes.

- **Binance Wallet**. The
  [official developer docs](https://developers.binance.com/docs/binance-w3w/bitcoin-provider)
  document `window.binancew3w.bitcoin` with `requestAccounts` /
  `getPublicKey` / `signPsbt` / `signMessage` / etc. Disassembly of
  v1.17.2 (current Chrome Web Store) shows the binary injects
  `window.binancew3w.{wallet, ethereum, solana, tron, sui, tonconnect}`
  — the `.bitcoin` namespace is documented but not actually shipped.
  Same situation as Phantom: detect returns false, wallet doesn't
  surface, signer ready to activate the moment Binance enables the
  documented API.

Adapter shape for Binance is matched against
[LaserEyes' production-deployed `binance.ts` provider](https://github.com/omnisat/lasereyes-mono/blob/main/packages/core/src/client/providers/binance.ts),
which is used by multiple Ordinals integrations.

If you're integrating against ordpool-sdk and care about either
wallet: the code paths exist and are exported; please
[file an issue](https://github.com/ordpool-space/ordpool-sdk/issues)
if you encounter a real wallet build that exposes the surface and
the adapter doesn't work as expected.

## Code conventions

- TypeScript strict mode. No `any`.
- `Uint8Array`, not Node `Buffer`. Same browser-compat rule as the parser.
- `ArrayBuffer.isView(x)` not `x instanceof Uint8Array` for binary-data type guards.
- `TextEncoder` / `TextDecoder` for string encoding.
- `fetch + AbortController` for HTTP. **Never axios.**
- Pure functions preferred. The SDK has side effects (it talks to networks) but compose them at entry points; keep the core pure.
- Behaviour-only comments. Describe what the code does NOW. Regression-pinning tests are the one allowed exception.

## Testing

- Jest, dual config: `npm run test:node` + `npm run test:browser`.
- Real responses from real mainnet endpoints where the test exercises an
  endpoint. Synthetic fixtures hide protocol mismatches.
- Exact assertions, not ranges. `toBe(9925)`, not `toBeGreaterThan(0)`.
- Wallet integration is split into two pipelines:
  - **Adapter Pipeline (A):** mocked wallet API → pins our adapter.
    Lives in `src/wallet/signers/*.signer.angular.spec.ts`. Fast,
    runs on every `npm test`.
  - **Wallet Pipeline (B):** real `.crx` running headed in xvfb on CI.
    Lives in `e2e/playwright/specs/<wallet>-*.spec.ts`. CI-only; we
    never run unverified extension binaries on dev machines.

## Commands

```bash
npm install                 # also runs `prepare` → builds dist/
npm test                    # node + browser test suites
npm run test:node           # node tests only
npm run test:browser        # jsdom browser tests only
npm run build               # ng-packagr (ESM + CJS dual output)
```

## Why two packages

We own three TypeScript codebases:

- [`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser)
  — zero runtime dependencies, pure functions, runs anywhere.
- [`ordpool-sdk`](https://github.com/ordpool-space/ordpool-sdk) —
  higher-level domain code that can have dependencies and side effects.
- `ordpool/frontend` and `ordpool/backend` — forked from mempool.

Helpers that should be reusable from a CLI, GitHub Action, third-party
app, or another ecosystem repo belong in the parser or the SDK
depending on shape (pure-function vs. networked).

The cat21-wallet repo (also part of the ecosystem) deliberately
delegates almost all CAT-21 PSBT construction to this SDK; the wallet
is responsible only for displaying cats, preserving `nLockTime=21`
through RBF, and exposing an MCP server. See
[`cat21-wallet/CLAUDE.md`](https://github.com/ordpool-space/cat21-wallet/blob/main/CLAUDE.md)
for the wallet's scope.

## License

MIT
