# ordpool-sdk

Higher-level Bitcoin / Ordinals SDK for the [ordpool](https://ordpool.space)
ecosystem. Sits one layer up from
[`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser):
the parser pulls artifacts (inscriptions, runes, BRC-20, SRC-20,
CAT-21, Atomicals, Labitbu, OpenTimestamps) out of raw transactions;
**ordpool-sdk** is the domain layer on top — networking, signing,
REST wrappers, marketplace flows.

MIT-licensed. Works in Node.js and browsers. No npm publish; consumers
pin a git SHA:

```jsonc
"ordpool-sdk": "github:ordpool-space/ordpool-sdk#<sha>"
```

The `prepare` lifecycle script builds `dist/` automatically when a git
ref is installed.

## Architecture: layered security

CAT-21 safety is enforced **before** the wallet signs. Five steps,
single responsibility each:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Caller DECLARES intent (mint / transfer / buy / sell-accept)     │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 2. SDK GATES the intent                                             │
│    validateCat21Operation (shape, addresses, fee/price caps)        │
│    evaluateAgentPolicy   (autonomous-mode spend / counterparty)     │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 3. SDK BUILDS the PSBT from the validated intent                    │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 4. SDK RE-VALIDATES bytes vs intent (defence-in-depth on offers)    │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 5. Wallet shows signPsbt UI, user confirms, wallet signs            │
└─────────────────────────────────────────────────────────────────────┘
```

### Why the wallet stays dumb

Inferring "this PSBT is a buy-offer / transfer / mint" from raw
bytes is unwinnable — every heuristic eventually gets bypassed. The
wallet shows inputs / outputs / fee, asks for a click, signs. Intent
is declared upstream and validated **before** the PSBT exists. By
the time bytes reach the wallet, the gate is already closed.

### What the wallet IS responsible for

Structural defaults, not intent inference:

- **Cat-bearing UTXO protection.** BTC-send coin-selection never
  picks a UTXO that holds a cat — they're removed from the spend
  pool.
- **nLockTime preservation through RBF.** Replacement txs carry the
  original locktime verbatim.

See [`cat21-wallet/CLAUDE.md`](https://github.com/ordpool-space/cat21-wallet/blob/main/CLAUDE.md)
HARD RULE #6 for the wallet-side framing.

## Consumers

Three profiles in the ecosystem:

| Consumer | What they need from the SDK |
|---|---|
| **cat21.space** (Angular 21 site) | Mint flow (build PSBT → ask wallet to sign → broadcast), offer flow (build buy-offer PSBT, validate inbound offers), wallet picker + per-wallet signer quirks, cat21-ord API client |
| **cat21-wallet** (Chrome extension) | `validateCat21Operation` (entry gate on every typed cat21_* RPC), `validateCat21BuyOfferPsbt` (defence-in-depth before signPsbt), `evaluateAgentPolicy` (autonomous mode), all PSBT builders. Wallet owns no construction logic. |
| **autonomous bots** (CLI / Discord / Twitter) | Agent-mode policy gate, broadcast dispatcher (Slipstream fallback), per-wallet signer for whichever wallet the operator wired up |

Any consumer can take any subset without pulling in framework deps:
pure functions return plain data, network calls take a `fetchImpl`,
signing is decoupled from broadcast.

## Modules

Each top-level `src/` directory is its own module. `src/index.ts`
is the single export point; everything else is internal.

### `src/cat21-mint/` — mint pipeline

- `cat21.service.helper.ts` — `createInput()` (per-wallet sequence: cat21wallet → 0xfffffffd RBF-signaling, every other wallet → 0xfffffffe non-RBF; both keep lockTime enforced); `createTransaction()` (lockTime=21 hardcoded); per-wallet input scripts for Xverse, Leather, Unisat.
- `cat21.service.ts` — top-level orchestration: build, simulate, broadcast.
- `cat21-mint-orchestrator.service.ts` — state machine for cat21.space UI: `idle` → `minting` → `success` / `error`.
- `cat21-api.service.ts` — REST wrapper to the cat21 backend.
- `utxo-content-scanner.service.ts` — scans UTXOs for cat-bearing outputs.

See `cat21-mint/README.md` (if present) for deeper notes; the
canonical safety invariants live in `.claude/CLAUDE.md` HARD RULE
"CAT-21 mints — RBF policy (per-wallet)".

### `src/cat21-validation/` — operation gate

Single validation entry for all four CAT-21 mutating operations.
Returns a discriminated union: `{ ok: true, resources }` or
`{ ok: false, reason, detail? }`. No exceptions, no `Validated<I>`
brand — type narrowing happens via the result.

```ts
import { validateCat21Operation, Network } from 'ordpool-sdk/core';

const result = validateCat21Operation({
  config: {
    network: Network.Mainnet,
    maxFeeRatePerVbyte: 1000,
    maxPriceSats: 21_000_000_000,
    ownPaymentAddress: 'bc1q...',           // blocks self-send
    allowedRecipients: ['bc1q...'],          // positive allowlist
    allowedCounterparties: ['bc1q...'],      // for create_offer
    allowedOperations: ['mint', 'transfer'], // capability allowlist
    maxOfferPsbtBytes: 128 * 1024,           // accept_offer DoS guard
  },
  operation: {
    kind: 'mint',
    intent: { recipient: 'bc1q...', feeRate: 5 },
  },
});

if (!result.ok) {
  console.warn(result.reason, result.detail); // 33 closed-set reasons
  return;
}
// result.resources carries pre-decoded scriptPubKey, parsed catId, ...
```

**Intents** — `mint { recipient, feeRate, tip? }`,
`transfer { catId, recipient, feeRate }`,
`create_offer { catId, priceSats, paymentAddress }`,
`accept_offer { offerPsbt, expectedCatId, expectedPriceSats, expectedSellerUtxo }`.

**What the gate enforces:**

- Address shape per network. Mainnet address on testnet config →
  `recipient-wrong-network`, not `-not-a-bitcoin-address`.
- BIP173 case-insensitive equivalence for self-send + allowlist
  (so `BC1Q…` and `bc1q…` match).
- Fee rate: finite, integer, positive, under `maxFeeRatePerVbyte`.
- Price: finite, integer, positive, at or above the 546-sat postage
  floor, under `maxPriceSats`.
- Cat-id: `<64-hex>i<vout>` regex.
- Accept-offer PSBT: hex OR base64, starts with PSBT magic
  (`0x70 0x73 0x62 0x74 0xff`), under `maxOfferPsbtBytes`.
- Operation kind: when `allowedOperations` is set, the kind must be
  in the list. Fires BEFORE field validation so a disallowed-kind
  probe can't leak field-level reasons.

**Property-fuzzed.** ~30 garbage shapes (Symbol, BigInt, NaN,
Infinity, prototype-less objects, RTL-override Unicode, raw
Buffers, function references) × every field × every operation. The
gate never throws — any unrecognized input returns a typed reason
from the closed set. 315 tests on this module alone.

**Use in cat21-wallet:** every `Cat21RpcService.{mint,transfer,
createOffer,acceptOffer}` method opens with one `validateCat21Operation`
call. No wallet-side invariants; SDK is the single source of truth.

### `src/cat21-offer/` — ord-style buyer-initiated offers

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

**Defence-in-depth:** the cat21-wallet runs
`validateCat21BuyOfferPsbt` again before showing the signPsbt UI.
SDK validates; wallet re-validates. Typed rejection surfaces in the
popup.

### `src/cat21-broadcast/` — mempool / Slipstream dispatcher

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

### `src/agent-mode/` — autonomous-action policy gate

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

**Stateless.** Caller tracks `spentTodaySats` (localStorage in a
browser, SQLite in a bot); SDK just evaluates.

### `src/wallet/` — wallet picker + signer adapters

- `signers/*.signer.ts` — per-wallet adapter (Xverse, Leather, Unisat,
  OKX, Oyl, Wizz, Phantom, Alby, Binance, Cat21Wallet). Detect by
  signature; only wallets whose `window.<wallet>` is live at runtime
  surface in the picker. (Binance is the one exception — the connector
  + signer ship but are intentionally NOT in the picker registry; see
  "Potentially supported, untested" below.)
- `connectors/` — wallet-side connect-flow handling.
- `wallet.service.ts` — top-level wallet API.
- `psbt-extract.ts` — pull signed input data out of a returned PSBT.
- `sighash.ts` — `BIP341_KEYPATH_SIGHASHES = [0x00, 0x01]`. Per
  BIP-341 a Taproot key-path spend commits identically under
  SIGHASH_DEFAULT and SIGHASH_ALL; signer + harness whitelists
  accept both shapes so the SDK can emit either.

#### Stale-cache defence: `onAccountChange`

When the user switches account or network inside the wallet's own
UI, the consumer's cached `paymentAddress` / `paymentPublicKey`
goes stale. The next mint signs over the wrong inputs.

Every connector ships an `onAccountChange(handler) => unsubscribe`
method. Native wallet events feed it where available; otherwise
it returns a no-op `() => undefined` so the consumer's lifecycle
code stays uniform across wallets.

```ts
import { unisatConnector } from 'ordpool-sdk';

const unsubscribe = unisatConnector.onAccountChange?.(() => {
  // wallet info just changed — drop the cache and re-connect.
  walletInfo.set(null);
  unisatConnector.connect(currentNetwork).subscribe(info => walletInfo.set(info));
});

// later, on component teardown:
unsubscribe?.();
```

**Per-wallet event support:**

| Wallet | Native events | Source | Notes |
|---|---|---|---|
| Unisat | ✅ | `window.unisat.on('accountsChanged' \| 'networkChanged', cb)` | |
| Wizz | ✅ | `window.wizz.on(...)` | Unisat-fork shape |
| OKX | ✅ | `window.okxwallet.bitcoin.on('accountChanged' \| 'networkChanged', cb)` | Singular `accountChanged` (vs Unisat's plural); fan-in handles it. LaserEyes skips OKX events; we wire them. |
| Binance | ✅ | `window.binancew3w.bitcoin.on(...)` | Documented but the v1.17.2 binary doesn't inject the `.bitcoin` surface yet; subscription is a no-op until it does. Connector is currently excluded from the picker registry — see "Potentially supported, untested" below |
| Xverse | ✅ | sats-connect `addListener('accountChange' \| 'networkChange' \| 'disconnect', cb)` | Includes `disconnect` — fan-in treats all three as "cache stale" |
| Phantom | ✅ | `window.phantom.bitcoin.on(...)` | Desktop ships btc.js dormant so `detect` already returns false on desktop; mobile in-app browser is documented to expose the events. Safe no-op when surface absent. |
| Cat21Wallet | (none) | Leather-forked API — no documented event surface | Use polling fallback |
| Leather | (none) | No documented event surface | Use polling fallback |
| Oyl | (none) | No documented event surface | Use polling fallback |
| Alby | (none) | webbtc has no event API | Use polling fallback |

**Polling fallback (no popup):** for wallets without events, calling
`connect()` again is silent once the user has previously approved
the connection. The wallet returns the current account without
showing a popup. Consumers should re-call `connect()` on
`visibilitychange` (tab regains focus) and at sign-time as a
defence-in-depth guard. Never poll on a timer — that's both
spammy and unnecessary.

#### Wrong-network detection

Address prefixes carry the network — no extra wallet call needed,
no popup. The SDK ships two helpers for the consumer's red-banner
"wallet is on the wrong network" check:

```ts
import { getAddressNetwork, isAddressCompatibleWithNetwork } from 'ordpool-sdk';

// Coarse grouping: 'mainnet' | 'regtest' | 'testnet'.
const group = getAddressNetwork(walletInfo.address);
// → 'mainnet' for bc1... / 1... / 3...
// → 'regtest' for bcrt1...
// → 'testnet' for tb1... / m... / n... / 2...

// Consumer's wrong-network gate:
if (!isAddressCompatibleWithNetwork(walletInfo.address, configuredNetworkGroup)) {
  showRedBanner('Wallet is on the wrong network — switch to mainnet');
  refuseSignButton();
}
```

The compatibility check is **lenient on the legacy testnet/regtest
ambiguity** — `m...` / `n...` / `2...` addresses share key bytes
across testnet and regtest, so the address alone can't disambiguate
and the gate returns `true` for both. Bech32 (`bc1` / `tb1` /
`bcrt1`) is unambiguous and the gate is strict there.

### Other

- `network.ts` — `Network` enum (Mainnet / Testnet3 / Testnet4 / Signet
  / Regtest) and conversion helpers (`toScureNetwork`,
  `toBitcoinNetworkType`, `toLeatherNetworkString`).
- `network-token.ts` — currency / asset constants.
- `storage-like.ts` — minimal interface so callers can plug
  localStorage, AsyncStorage, an in-memory map, etc.

## Status

API is wired and tested. New consumer integrations welcome; file an
issue if you need a missing piece or a new wallet adapter.

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
| Binance Wallet | **Code ships but excluded from picker — see note below** |
| Watch-only (xpub) | ✅ (Sparrow, Electrum, Coldcard, Ledger, Trezor, Specter, Bitcoin Core via PSBT paste) |

### Potentially supported, untested

Two wallets ship code matched against official developer docs but
can't be exercised end-to-end yet:

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

  Different from Phantom: even with detect-by-signature in place
  (gate on `window.binancew3w.bitcoin`), there's no released binary
  in which detect can succeed, so no end-user can exercise the
  signer and produce real signal. Listing it as "click to download"
  is a broken promise — the user installs the extension, the
  picker still shows Binance as "not installed" because the
  documented sub-provider is absent.

  As of f106cd2 (2026-06-21), `binanceConnector` is intentionally
  removed from the `walletConnectors` registry in
  [`src/wallet/connectors/index.ts`](src/wallet/connectors/index.ts).
  The connector + signer files (`binance.connector.ts`,
  `binance.signer.ts`), the `KnownOrdinalWalletType.binance` enum
  value, and the `KnownOrdinalWallets.binance` metadata entry all
  stay on disk. To re-enable:

  ```ts
  // src/wallet/connectors/index.ts
  import { binanceConnector } from './binance.connector';
  // ...
  export const walletConnectors: readonly WalletConnector[] = [
    cat21walletConnector,
    xverseConnector,
    leatherConnector,
    unisatConnector,
    wizzConnector,
    okxConnector,
    phantomConnector,
    oylConnector,
    albyConnector,
    binanceConnector,  // ← add back
  ];
  ```

  Plus restore the asserts in `src/wallet/connectors/connectors.spec.ts`
  that the f106cd2 commit inverted. Build + ship a new SHA; the
  picker entry comes back across every consumer.

Adapter shape for Binance is matched against
[LaserEyes' production-deployed `binance.ts` provider](https://github.com/omnisat/lasereyes-mono/blob/main/packages/core/src/client/providers/binance.ts),
which is used by multiple Ordinals integrations.

Code paths exist and are exported. If you hit a real wallet build
that exposes the surface and the adapter misbehaves,
[file an issue](https://github.com/ordpool-space/ordpool-sdk/issues).

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
- Wallet integration is split into three pipelines:
  - **Adapter Pipeline (A):** mocked wallet API → pins our adapter.
    Lives in `src/wallet/signers/*.signer.angular.spec.ts`. Fast,
    runs on every `npm test`.
  - **Wallet Pipeline (B):** real `.crx` running headed in xvfb on CI.
    Lives in `e2e/playwright/specs/<wallet>-*.spec.ts`. CI-only; we
    never run unverified extension binaries on dev machines.
  - **PSBT-export Pipeline:** for watch-only wallets (Sparrow,
    Electrum, Coldcard, Ledger, Trezor, …). Lives in
    `e2e/regtest/psbt-export-roundtrip.spec.ts` — uses Bitcoin Core's
    `walletprocesspsbt` as the BIP-174-canonical external signer
    against a Docker regtest stack. Any conformant wallet emits the
    same wire format; if `psbtExportSigner` consumes Bitcoin Core's
    PSBT, it consumes them all.
- `psbtExportSigner` accepts both partial-sig AND already-finalized
  PSBTs — `isFinal` is checked so wallets that finalize themselves
  (Bitcoin Core GUI, some hardware-wallet desktop suites) flow
  through without a re-finalize attempt.

## Commands

```bash
npm install                 # also runs `prepare` → builds dist/
npm test                    # node + browser test suites
npm run test:node           # node tests only
npm run test:browser        # jsdom browser tests only
npm run build               # ng-packagr (ESM + CJS dual output)
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

The cat21-wallet delegates almost all CAT-21 PSBT construction here
— the wallet displays cats, preserves `nLockTime=21` through RBF,
and exposes an MCP server. See
[`cat21-wallet/CLAUDE.md`](https://github.com/ordpool-space/cat21-wallet/blob/main/CLAUDE.md)
for scope.

## License

MIT
