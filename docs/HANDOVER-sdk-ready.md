# ordpool-sdk is ready — wallet-picker handover for the three consumer sites

**To:** the cat21.space, ordpool.space, and cubes frontend sessions.
**From:** the ordpool-sdk session.

The SDK's wallet layer is final and proven. This orients you; the
detailed, binding specs are linked below. Read your site's section, then
the two shared specs, then build.

## Pin this SDK

```jsonc
// package.json
"ordpool-sdk": "github:ordpool-space/ordpool-sdk#2a7d0c1"
```

Then update the lockfile and commit `package.json` + the lockfile together
(CI caches by lockfile hash). Import surface:

- **Angular sites** (cat21.space, ordpool.space): `import { … } from 'ordpool-sdk'`
- **cubes** (Angular 16, avoid Angular-version coupling): `import { … } from 'ordpool-sdk/core'`

`Run Tests` and `E2E (regtest)` are green at this SHA.

## What you're wiring, in one paragraph

The SDK is now the single source of truth for **which wallet can do what,
on which platform, how well proven**. You build the picker from that matrix
instead of a hardcoded list, show an **info icon** on every wallet row that
explains capabilities, keep unavailable actions **visible-but-disabled with
a reason** (never silently hidden), and — new — you can connect a
**watch-only wallet from a pasted xpub**. All wallet facts come from the
SDK; you own the presentation.

## The SDK API you'll use

```ts
import {
  WALLET_MATRIX, WalletCapability, WalletPlatform, CapabilitySupport,
  walletsSupporting, walletsForPlatform, capabilityOf, supportsCapability,
  walletInAppBrowserDeepLink,                 // mobile in-app deep links
} from 'ordpool-sdk';        // or 'ordpool-sdk/core' for cubes
```

- `walletsSupporting(capability, { platform, minSupport })` — the wallets to
  offer for an action, already filtered. Each carries `label`, `platforms`,
  `signingMode`, per-capability `caveat`, wallet-level `note`.
- `capabilityOf(wallet, capability)` → `{ support, caveat? }` (total: unknown
  pairs resolve to `Unsupported`).
- `walletsForPlatform(platform)` — everything reachable on a platform.
- `walletInAppBrowserDeepLink(wallet, targetUrl)` — a docs-verified in-app
  browser deep link, or `null` (only Xverse is verified today).

Watch-only (xpub), Angular sites:

```ts
const info = await firstValueFrom(walletService.connectXpub({
  extendedPublicKey: pastedKey,
  scriptType: 'p2tr',            // omit for ypub/zpub/…; required for plain xpub/tpub
  probe: (address) => yourElectrsProbe(address),
}));
// `info` is a normal WalletInfo on connectedWallet$ — every existing flow works with it.
```

## What is proven (so you can trust the matrix)

Every operation below is a real regtest e2e (build → sign → broadcast, no
mocks) unless noted:

- **7 wallets × 6 operations proven**: Cat21 Wallet, Xverse, Leather, UniSat,
  Wizz, OKX, and **Watch-only (xpub)** — mint, transfer, offer-create,
  offer-accept, inscribe, parent/child inscribe.
- **Watch-only end to end**: a pasted xpub → derive → scan (real electrs) →
  mint → broadcast is proven (`watch-only-mint-roundtrip.spec.ts`), plus the
  derive/scan layers against `bitcoin-cli`. This is the path Sparrow /
  Electrum / Coldcard / Ledger users take.
- **Alby**: mint / transfer / inscribe proven; **offers and collections are
  Unsupported** (its `signPsbt` signs every input with one Taproot key — no
  per-input selection).
- **Phantom, Binance**: mobile-in-app only (desktop binaries don't inject a
  usable provider). The matrix already excludes them on desktop.

## Honest caveats to surface (don't paper over these)

- **OKX collections (parent/child)**: `Proven` with a caveat. The SDK code
  path and both signs are reliable; the 3-popup child e2e has a residual
  **environmental** flake in CI (OKX extension load/connect in headed
  chromium) that passes on retry. This is browser-automation stability, not
  an SDK or signing problem — a production integration is fine, surface a
  "may need a retry" note if you expose the action.
- **UniSat / Wizz collections**: require the wallet's **active address type
  to be Taproot (P2TR)**. Check before offering; block with a "switch to
  Taproot and reconnect" message otherwise.
- **Alby**: any operation must be funded from a **Taproot** UTXO (signing
  constraint, not a holding one). Any address type can HOLD a cat — do NOT
  block on the recipient's address type. (The old "bc1q cannot hold cats"
  claim was wrong and is gone.)
- **Watch-only**: `SignMessage` is `Unsupported` by design (BIP-322 is
  interactive, nothing to export) — hide that affordance.

## Your documents

Read your site's doc, then the two shared specs (both **binding** — they
keep the three sites identical where it matters):

| Doc | For |
|---|---|
| `docs/wallet-picker-cat21.space.md` | cat21.space — full picker, all six actions |
| `docs/wallet-picker-ordpool.space.md` | ordpool.space — the `/cat21-mint` page (+ a parent/child section if it grows) |
| `docs/wallet-picker-cubes.md` | cubes — `Inscription` only, imports from `/core` |
| `docs/wallet-picker-ux-shared.md` | **binding** — capability messaging, the info icon (structure + wording tables), mobile deep links, platform-vs-capability rule |
| `docs/wallet-picker-watch-only-shared.md` | **binding** — the xpub connect contract (derive/scan/connect, the probe you wire, the export/paste signing bridge) |
| `CHILD-INSCRIBE-WALLET-SUPPORT.md` | the parent/child mechanism + per-wallet support |

## The two things the shared spec makes non-negotiable

1. **Filter by platform, EXPLAIN by capability.** A wallet unreachable on
   the current platform is hidden. A wallet that can't do the *current
   action* is NOT hidden from a connected user — render the action disabled
   with the matrix-sourced reason and the alternatives (e.g. a connected
   Alby user sees why "sell" is disabled, not an emptier screen).

2. **The info icon on every wallet row**, in the same place on all three
   sites (right after the wallet name, also on Download and watch-only
   rows): a clickable/keyboard popover showing what the current action
   needs and everything the wallet supports, sourced from the matrix with
   the shared wording tables. Each site keeps its own visual design; the
   structure, order, icons, wording, and data source are identical.

## The alignment workflow (follow exactly)

1. **Implement your own version** from your doc + the two shared specs.
   Then **STOP** — do not read or edit the sister implementations yet.
2. **The maintainer reviews** your implementation.
3. **Only after that review**: cross-check the two sister implementations,
   look for drift (icon placement, popover structure, wording, disabled-
   action notices), and **propose** your alignment findings to the
   maintainer (a short list of differences + which variant should win and
   why). Never silently edit a sister project.

Ship your slice, stop, and hand back. The SDK won't move under you — this
SHA is stable.
