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
  Hub needed), but may default to a native-SegWit address that cannot hold
  a cat. Verify the connected address is Taproot (`bc1p`) before minting.
- **Watch-only (xpub)**: `signingMode === 'watch-only'` — no in-page
  signing; the mint ends by handing the user a PSBT to sign elsewhere.
  Present it as an export step, not a "Connect" button.

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

## What stays yours

- Platform detection and any mobile deep-link UX.
- Runtime provider detection (installed vs not).
- The mint page's design and the caveat presentation.

The SDK owns the wallet facts; ordpool.space owns the mint-page UX.
