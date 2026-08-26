# Wallet-picker handover — ordpool.space

For the ordpool.space consumer session (`ordpool/frontend`, Angular 20).
ordpool.space is the block explorer; its wallet surface is the CAT-21 mint
page (`/cat21-mint`). This is how to drive that picker off the SDK's
capability matrix so it only offers wallets that can actually mint for the
current user.

## Scope

ordpool.space's wallet need is narrow: **minting** (`Cat21Mint`), plus
whatever inscription/mint-adjacent actions the mint page grows. It is not
the marketplace (that is cat21.space), so it does not need the transfer /
offer / collection surfaces. Keep the picker scoped to the capability the
page actually uses.

## The SDK API

```ts
import {
  WalletCapability, WalletPlatform, CapabilitySupport,
  walletsSupporting, capabilityOf,
} from 'ordpool-sdk';           // Angular entry
```

- `walletsSupporting(capability, { platform, minSupport })` — the wallets
  to offer, already filtered by platform and support level. Each entry
  carries `label`, `platforms`, `signingMode`, and any `caveat` / `note`.
- `capabilityOf(wallet, capability)` → `{ support, caveat? }` (total).

## The picker flow for the mint page

```ts
// Desktop mint page:
const candidates = walletsSupporting(
  WalletCapability.Cat21Mint,
  { platform: WalletPlatform.Desktop },
);
// → Cat21 Wallet, Xverse, Leather, UniSat, Wizz, OKX, Alby, Watch-only(xpub)
//   (Phantom + Binance are mobile-only, correctly excluded on desktop)
```

Then cross-reference with the runtime provider detection (the mint page's
existing `WalletService` / detect logic) to mark each candidate installed
vs "get the extension".

If you want to show only regtest-verified wallets on the primary path and
demote the rest, split by support level:

```ts
const proven  = walletsSupporting(WalletCapability.Cat21Mint,
  { platform: WalletPlatform.Desktop, minSupport: CapabilitySupport.Proven });
// → Cat21 Wallet, Xverse, Leather, UniSat, Wizz, OKX, Alby, Watch-only(xpub)
// (every desktop wallet's mint is Proven — the Adapter remainder is empty;
//  the watch-only path is proven via bitcoin-cli walletprocesspsbt)
```

## Platform detection (yours)

The explorer audience is mostly desktop, so `WalletPlatform.Desktop` is the
common case. If you support mobile:

- **Mobile inside a wallet's in-app browser** (Xverse / OKX) →
  `walletsSupporting(Cat21Mint, { platform: WalletPlatform.Mobile })` →
  Xverse, OKX, Phantom, Binance, Watch-only. Runtime detect narrows to the
  one provider actually injected.
- **Mobile plain browser** → no injected wallet; offer a deep-link into a
  wallet's in-app browser, or the watch-only export path.

The SDK provides the capability data; the consumer detects the runtime
platform (a `navigator` heuristic plus the SDK's provider detect).

## Caveats to surface on the mint page

Mint is the least caveat-heavy operation (every listed wallet supports it),
but two still apply:

- **Alby**: signs on-chain via WebBTC with the account master key (no Alby
  Hub needed). Signing constraint: it Taproot-signs every input with one
  Taproot key, so the mint's funding input must be a Taproot UTXO (a
  non-Taproot input fails to sign). Any address type can HOLD a cat; do
  NOT block minting on the recipient's address type.
- **Watch-only (xpub)**: `signingMode === 'watch-only'` — no in-page
  signing; the mint ends by handing the user a PSBT to sign elsewhere.
  Present it as an export step, not a "Connect" button.
  **Wired now**: connect with `WalletService.connectXpub` (Angular) or
  compose `scanWatchOnly` from `/core` (cubes); full contract +
  probe-wiring in `wallet-picker-watch-only-shared.md`. Proven end to end
  on regtest (pasted xpub → scan → mint → broadcast).

Read `capabilityOf(w, Cat21Mint).caveat` and the entry `note` rather than
hardcoding wallet notes in the frontend.

## Migration checklist

1. Build the mint-page picker from `walletsSupporting(Cat21Mint, {...})`
   instead of any hardcoded list.
2. If the mint page currently offers a wallet with no SDK signer (e.g. an
   Oyl entry copied from elsewhere), it disappears automatically — the
   matrix only contains SDK-backed wallets.
3. Phantom is correctly desktop-hidden via the platform filter; no special
   case needed.
4. Keep the picker scoped to `Cat21Mint` (and any other capability the page
   truly uses) so you don't advertise operations the mint page can't drive.

## Parent/child (collections): what is proven, if ordpool grows that surface

ordpool's wallet surface today is the mint page, but the SDK's parent/child
(ord provenance) support is now proven broadly, so gate any future inscribe
or collections surface with `WalletCapability.InscriptionParentChild` and
you inherit this state:

- **Proven on regtest for seven wallets**: Cat21 Wallet, Xverse, Leather,
  UniSat, Wizz, OKX, and the watch-only (xpub) path. Each runs a real child
  roundtrip: the wallet signs the reveal's Taproot parent input on a BARE
  wallet-facing PSBT (the ord envelope is stripped, so the wallet never has
  to understand it), the SDK merges that signature into the full reveal,
  finalizes both inputs, broadcasts, and stock ord confirms the provenance
  link plus the parent returning to its owner at 546 sats.
- **Watch-only included**: the external wallet (bitcoin-cli
  walletprocesspsbt as the BIP-174 stand-in for Sparrow/Coldcard/Ledger)
  partial-signs the bare reveal with finalize=false; the SDK does the rest.
- **Alby is the only Unsupported**: its signPsbt signs every input with one
  Taproot key and has no per-input selection, so it cannot leave the
  ephemeral commit input alone. Show the action disabled with the reason
  (shared UX doc), never a vanished button.
- **UniSat / Wizz caveat**: the active wallet address type must be Taproot
  (P2TR) or the reveal sign fails with `invalid address in toSignInput`.
- Full mechanism and per-wallet notes: `CHILD-INSCRIBE-WALLET-SUPPORT.md`
  in the SDK repo.

## Deep integration + shared UX (required)

Read `docs/wallet-picker-ux-shared.md` (same repo) before building. It is
binding for all three consumer sites and specifies:

1. **Capability messaging beyond the picker**: mint is Proven everywhere,
   but the info popover still shows the wallet's FULL capability list, so
   a user learns e.g. that their Alby cannot trade cats before they head
   to cat21.space.
2. **The info icon** on every wallet row in the connect box (next to the
   wallet name, also on Download and watch-only rows): placement, popover
   structure, and the exact shared wording tables.
3. **The alignment workflow**: implement your own version first, then
   STOP; the maintainer reviews; only after that review cross-check the
   sister implementations (cat21.space, cubes) and PROPOSE your alignment
   ideas, never silently edit them.

## What stays yours

- Platform detection and any mobile deep-link UX.
- Runtime provider detection (installed vs not).
- The mint page's design and the caveat presentation.

The SDK owns the wallet facts; ordpool.space owns the mint-page UX.
