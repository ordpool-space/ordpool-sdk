# Wallet-picker handover — cubes.haushoppe.art

For the cubes consumer session (`genesis/apps/cubes-frontend`, Angular 16 +
NgRx). cubes.haushoppe.art mints Ordinal Cubes, which are HTML inscriptions
on Bitcoin. This is how to drive its wallet picker off the SDK's capability
matrix so it only offers wallets that can actually inscribe for the current
user.

## Scope

A cube is a plain HTML **inscription**. The cubes wallet surface needs one
capability: `Inscription`. It does not mint cats, transfer, or trade, so
keep the picker scoped to `Inscription` and do not advertise the cat
operations.

## Import from the main entry (NOT `/core`)

The matrix + watch-only helpers are exported from BOTH `ordpool-sdk` and
`ordpool-sdk/core`. For cubes, import from the **main `ordpool-sdk` entry**:

```ts
import {
  WalletCapability, WalletPlatform, CapabilitySupport,
  walletsSupporting, capabilityOf,
  walletInAppBrowserDeepLink, scanWatchOnly, deriveWatchOnlyAddresses,
} from 'ordpool-sdk';
```

Why not `/core` here: the genesis cubes e2e workflow
(`e2e-cubes-regtest.yml`) installs with `npm ci --ignore-scripts`, so the
SDK's `prepare` step never runs and `dist-core/` (what `/core` maps to, and
which is NOT checked into git) is never built. `import … from
'ordpool-sdk/core'` then fails the CI build with `Could not resolve
"ordpool-sdk/core"`. The main entry's `dist/` IS checked into git and
resolves with no build step. The matrix is pure data + functions, so the
Angular fesm bundle loads fine under cubes' Angular 16 with no version
coupling. Use the same main entry cubes already imports its SDK inscribe
helpers from.

## The picker flow

```ts
// Desktop cube-mint page:
const candidates = walletsSupporting(
  WalletCapability.Inscription,
  { platform: WalletPlatform.Desktop },
);
// → Cat21 Wallet, Xverse, Leather, UniSat, Wizz, OKX, Alby, Watch-only(xpub)
```

Then cross-reference with the cubes flow's existing runtime provider
detection to mark each candidate installed vs "get the extension".

Every desktop wallet supports `Inscription`, proven on regtest for all of
them: Cat21 Wallet, Xverse, Leather, UniSat, Wizz, OKX, Alby, and the
watch-only path (via bitcoin-cli walletprocesspsbt). Phantom and Binance are
mobile-only and are correctly excluded by the desktop platform filter.

## Platform detection (yours)

- **Desktop** → the list above; runtime detect narrows to installed.
- **Mobile inside a wallet's in-app browser** (Xverse / OKX) →
  `walletsSupporting(Inscription, { platform: WalletPlatform.Mobile })` →
  Xverse, OKX, Phantom, Binance, Watch-only.
- **Mobile plain browser** → no injected wallet; deep-link into a wallet's
  in-app browser or use the watch-only export path.

The SDK provides the capability data; the consumer detects the runtime
platform (a `navigator` heuristic plus the SDK's provider detect).

## Caveats to surface

Inscription itself has no per-wallet blocker in the matrix, but two
wallet-level notes apply:

- **Alby**: signs on-chain via WebBTC with the account master key (no Alby
  Hub needed). Signing constraint: it Taproot-signs every input with one
  Taproot key, so the commit's funding input must be a Taproot UTXO (a
  non-Taproot input fails to sign). The inscription itself lands on a
  Taproot commit output by protocol design; the recipient address can be
  any type.
- **Watch-only (xpub)**: `signingMode === 'watch-only'` — no in-page
  signing; the flow ends by handing the user a PSBT to sign in their own
  wallet. Present it as an export step, not a "Connect" button.
  **Wired now**: connect with `WalletService.connectXpub` (Angular) or
  compose `scanWatchOnly` from the main `ordpool-sdk` entry (cubes); full contract +
  probe-wiring in `wallet-picker-watch-only-shared.md`. Proven end to end
  on regtest (pasted xpub → scan → mint → broadcast).

Read `capabilityOf(w, Inscription).caveat` and the entry `note` rather than
hardcoding wallet notes.

## If cubes ever become a collection

If a future cube drop uses ord parent/child provenance (a collection
parent with child cubes), switch that flow's capability to
`InscriptionParentChild` and the matrix handles the fallout automatically:
Alby becomes `Unsupported` (hide it), and UniSat / Wizz gain the
active-Taproot-address caveat (block until the user's active address type is
Taproot). Every other wallet, including OKX and watch-only, is proven for
parent/child. See `CHILD-INSCRIBE-WALLET-SUPPORT.md` for the mechanism.

## Migration checklist

1. Build the cube-mint picker from `walletsSupporting(Inscription, {...})`
   instead of any hardcoded list.
2. Any wallet in the old cubes list without an SDK signer (e.g. an Oyl
   entry) disappears automatically — the matrix only contains SDK-backed
   wallets. cubes-frontend regtest proved the SDK shim for the injected
   wallets; the matrix is the picker-side counterpart.
3. Phantom is desktop-hidden via the platform filter; no special case.

## Deep integration + shared UX (required)

Read `docs/wallet-picker-ux-shared.md` (same repo) before building. It is
binding for all three consumer sites and specifies:

1. **Capability messaging beyond the picker**: plain inscriptions work on
   every wallet; if cubes ever gain a parent/child flow, an Alby user
   must see the collection action DISABLED with the matrix-sourced
   reason, not a vanished button.
2. **The info icon** on every wallet row in the connect box (next to the
   wallet name, also on Download and watch-only rows): placement, popover
   structure, and the exact shared wording tables.
3. **The alignment workflow**: implement your own version first, then
   STOP; the maintainer reviews; only after that review cross-check the
   sister implementations (cat21.space, ordpool `/cat21-mint`) and
   PROPOSE your alignment ideas, never silently edit them.

## What stays yours

- Platform detection and any mobile deep-link UX.
- Runtime provider detection (installed vs not).
- The cube-mint page design and caveat presentation.

The SDK owns the wallet facts; cubes owns the mint UX.
