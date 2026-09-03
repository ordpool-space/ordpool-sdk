# Wallet-picker handover — cat21.space

For the cat21.space consumer session (`cat21-indexer/frontend`).
This is how to drive the wallet picker off the SDK's capability matrix so
the site only ever offers wallets that can actually serve the current user
and the current action.

## The problem this fixes

Today cat21.space shows a fixed wallet list that includes:
- **Phantom on desktop** — cannot work. Phantom's desktop extension ships
  its Bitcoin provider dormant, so connect always rejects. It only works in
  the Phantom mobile in-app browser.
- **Oyl** — there is **no Oyl signer in the SDK at all**. The SDK cannot
  drive it. It is a stale entry.

Both are exactly what the matrix removes: the SDK is now the single source
of truth for which wallets exist, on which platform, for which operation.

## The SDK API

```ts
import {
  WALLET_MATRIX, WalletCapability, WalletPlatform, CapabilitySupport,
  walletsSupporting, walletsForPlatform, capabilityOf, supportsCapability,
} from 'ordpool-sdk';           // main entry
```

- `WalletCapability` — the operation: `Cat21Mint`, `Cat21Transfer`,
  `Cat21OfferCreate`, `Cat21OfferAccept`, `Inscription`,
  `InscriptionParentChild`, `SignMessage`.
- `WalletPlatform` — `Desktop` | `Mobile`.
- `walletsSupporting(capability, { platform, minSupport })` — the wallets
  to offer for an action, already filtered. Each returned entry carries its
  `label`, `platforms`, `signingMode`, per-capability `caveat`, and a
  wallet-level `note`.
- `capabilityOf(wallet, capability)` → `{ support, caveat? }` (total: an
  unknown pair resolves to `Unsupported`).

`minSupport` defaults to `Adapter` (everything the SDK implements). Pass
`CapabilitySupport.Proven` when you only want regtest-verified wallets.

## The picker flow

```
1. Determine the platform (Desktop | Mobile)  ← your responsibility
2. Determine the action's WalletCapability     ← from the button the user clicked
3. candidates = walletsSupporting(capability, { platform })
4. Cross-reference with runtime detect (WalletService) → installed vs not
5. Render each candidate with its caveat badge; disable / hide the rest
```

### 1. Platform detection (yours, not the SDK's)

The SDK holds the capability data; detecting the runtime platform is the
consumer's job. `Mobile` in the matrix means "reachable inside the wallet's
own in-app dApp browser". On a **plain** mobile browser (Safari/Chrome) no
injected wallet is present, so:

- **Desktop** → `walletsForPlatform(Desktop)` are the candidates; runtime
  detect tells you which are installed.
- **Mobile, inside a wallet's in-app browser** → exactly one injected
  provider is present; show that wallet.
- **Mobile, plain browser** → no injected wallet works. Offer deep-links
  that open cat21.space inside a wallet's in-app browser (Xverse:
  `https://connect.xverse.app/browser?url=<cat21.space-url>`; OKX and
  Binance have their own), plus the watch-only path.

A simple `navigator`-based heuristic picks Desktop vs Mobile; combine it
with the SDK's `WalletService` detect to know whether an injected provider
is actually present.

### 2-3. Map each action to a capability

| User action on cat21.space | WalletCapability |
|---|---|
| Mint a cat | `Cat21Mint` |
| Send a cat | `Cat21Transfer` |
| List a cat for sale | `Cat21OfferCreate` |
| Buy a listed cat | `Cat21OfferAccept` |
| Inscribe an artifact | `Inscription` |
| Add to a collection (parent/child) | `InscriptionParentChild` |

Example — the "Add to collection" modal on desktop:

```ts
const candidates = walletsSupporting(
  WalletCapability.InscriptionParentChild,
  { platform: WalletPlatform.Desktop },
);
// → Cat21 Wallet, Xverse, Leather, UniSat, Wizz, OKX, xpub  (Alby is
//   excluded: its signPsbt has no per-input signing)
```

## Caveats you MUST surface

The whole point is honest UX. Read each candidate's `caveat` / `note` and
show it:

- **UniSat / Wizz + collections** (`InscriptionParentChild` carries a
  caveat): the user's **active wallet address type must be Taproot (P2TR)**.
  If it is Native SegWit, the reveal sign fails with `invalid address in
  toSignInput`. Before offering collections on these wallets, check the
  connected address type; if it is not Taproot, block the action and tell
  the user to switch to Taproot (P2TR) in their wallet and reconnect.
- **Alby + offers / collections**: both `Cat21OfferCreate` / `Cat21OfferAccept`
  and `InscriptionParentChild` are `Unsupported` on Alby. Its WebBTC `signPsbt`
  signs every input with one Taproot key and has no per-input selection, so it
  cannot leave a counterparty's or the ephemeral commit input alone. In the
  picker those actions exclude Alby automatically; on an already-connected
  Alby session render sell/buy/collection buttons DISABLED with the reason
  (see the shared UX doc), never silently hidden. Mint / transfer / plain
  inscribe work.
- **Alby funding is Taproot-only (a SIGNING constraint, not a holding
  one)**: Alby's WebBTC signs every input with its single Taproot key, so
  every input in an Alby-signed PSBT must be a Taproot UTXO (a non-Taproot
  input fails with "is not of type Taproot"). Any address type can HOLD a
  cat; the cat travels with its sat.
- **Watch-only (xpub)**: `signingMode === 'watch-only'`. There is no
  in-page signing; the flow ends by handing the user a PSBT to sign in
  their own wallet (Sparrow, Coldcard, Ledger, …). Present it as an export
  step, not a "Connect" button.
  **Wired now**: connect with `WalletService.connectXpub` (main entry) or
  compose `scanWatchOnly` from `/core` (cubes); full contract +
  probe-wiring in `wallet-picker-watch-only-shared.md`. Proven end to end
  on regtest (pasted xpub → scan → mint → broadcast).

## Migration checklist

1. Delete the hardcoded wallet list. Build the picker from
   `walletsSupporting(...)` / `walletsForPlatform(...)`.
2. **Remove Oyl** — no SDK signer exists; it can never work through the SDK.
3. **Stop showing Phantom on desktop** — the matrix already places Phantom
   on `Mobile` only, so a `walletsForPlatform(Desktop)` picker drops it
   automatically.
4. Gate the collections (parent/child) action per wallet via
   `capabilityOf(w, InscriptionParentChild)` — Alby unsupported;
   UniSat/Wizz need the Taproot-address check.
5. Badge every caveat from the matrix rather than hardcoding wallet notes
   in the frontend (they now live in one place and are updated with the
   SDK).

## Deep integration + shared UX (required)

Read `docs/wallet-picker-ux-shared.md` (same repo) before building. It is
binding for all three consumer sites and specifies:

1. **Capability messaging beyond the picker**: a connected Alby user must
   see WHY the sell/buy and collection buttons are disabled (with the
   matrix-sourced reason and alternatives), not an emptier UI. Same
   pattern for the UniSat/Wizz Taproot pre-check.
2. **The info icon** on every wallet row in the connect box (next to the
   wallet name, also on Download and watch-only rows): a clickable
   popover showing what the current action needs and everything the
   wallet supports, with the exact shared wording tables.
3. **The alignment workflow**: implement your own version first, then
   STOP; the maintainer reviews; only after that review cross-check the
   sister implementations (ordpool `/cat21-mint`, cubes) and PROPOSE your
   alignment ideas, never silently edit them.

## What stays yours

- Platform detection and the mobile in-app-browser deep-link UX.
- Runtime provider detection (installed vs "get the extension").
- The visual design of the picker and the caveat badges.

The SDK owns the facts (who can do what, where, how well proven). cat21.space
owns the presentation.
