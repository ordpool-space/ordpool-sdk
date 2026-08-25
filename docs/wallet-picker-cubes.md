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

## Import from the core entry

cubes-frontend is Angular 16; the SDK's Angular bundle is built with a much
newer Angular. Import the matrix from the **Angular-free** core entry to
avoid any Angular-version coupling (the matrix is pure data + functions, so
it lives in core):

```ts
import {
  WalletCapability, WalletPlatform, CapabilitySupport,
  walletsSupporting, capabilityOf,
} from 'ordpool-sdk/core';
```

(Use the same entry the cubes flow already imports its SDK inscribe helpers
from. The matrix is exported from both `ordpool-sdk` and `ordpool-sdk/core`.)

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

Every desktop injected wallet supports `Inscription` (proven for Cat21
Wallet, Xverse, Leather, UniSat, Wizz, OKX, Alby; adapter-level for
watch-only). Phantom and Binance are mobile-only and are correctly excluded
by the desktop platform filter.

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
  Hub needed), but may default to a native-SegWit address. A cube
  inscription is held on a Taproot output; verify the connected address is
  Taproot (`bc1p`) before inscribing.
- **Watch-only (xpub)**: `signingMode === 'watch-only'` — no in-page
  signing; the flow ends by handing the user a PSBT to sign in their own
  wallet. Present it as an export step, not a "Connect" button.

Read `capabilityOf(w, Inscription).caveat` and the entry `note` rather than
hardcoding wallet notes.

## If cubes ever become a collection

If a future cube drop uses ord parent/child provenance (a collection
parent with child cubes), switch that flow's capability to
`InscriptionParentChild` and the matrix handles the fallout automatically:
Alby becomes `Unsupported` (hide it), OKX carries a retry caveat (its child
operation is proven, its e2e just flakes on OKX-extension crashes), and
UniSat / Wizz gain the active-Taproot-address caveat (block until the user's
active address type is Taproot). See `CHILD-INSCRIBE-WALLET-SUPPORT.md` for
the mechanism.

## Migration checklist

1. Build the cube-mint picker from `walletsSupporting(Inscription, {...})`
   instead of any hardcoded list.
2. Any wallet in the old cubes list without an SDK signer (e.g. an Oyl
   entry) disappears automatically — the matrix only contains SDK-backed
   wallets. cubes-frontend regtest proved the SDK shim for the injected
   wallets; the matrix is the picker-side counterpart.
3. Phantom is desktop-hidden via the platform filter; no special case.

## What stays yours

- Platform detection and any mobile deep-link UX.
- Runtime provider detection (installed vs not).
- The cube-mint page design and caveat presentation.

The SDK owns the wallet facts; cubes owns the mint UX.
