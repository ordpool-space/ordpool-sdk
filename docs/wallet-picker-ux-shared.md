# Wallet-picker shared UX: capability messaging + the info icon

Binding for all three consumer sessions (cat21.space, ordpool.space, cubes).
The goal: wherever the wallet matrix surfaces, the three sites read and
behave identically, while each keeps its own visual design system. Read this
together with your site's handover doc before building.

## 1. Filter by platform, explain by capability

Two different mechanisms. Do not mix them:

- **Platform mismatches HIDE.** A wallet that is not reachable on the
  current platform (Phantom on desktop, UniSat on mobile) never appears.
  There is nothing to explain: the user cannot use it here.
  The matrix `platforms` list is the single authority for this; the SDK's
  `hiddenFromPicker` flag is only a desktop-detection convenience pinned to
  the matrix (a wallet is hidden iff the matrix marks it non-Desktop). A
  mobile-in-app picker reads `walletsForPlatform(Mobile)` — where Phantom /
  Binance DO appear — and must not consult `hiddenFromPicker`.
- **Capability gaps EXPLAIN.** A wallet that works on this platform but
  cannot do a specific action must not make that action silently vanish.
  The user learns why it is unavailable and which wallet to use instead.

Concretely:

- **Picker for an action**: `walletsSupporting(capability, { platform })`
  already excludes incapable wallets. That is correct for the picker: do
  not offer Alby in a "buy this cat" connect dialog.
- **Already-connected wallet, action buttons in the page**: do NOT hide
  the action. Render it disabled with an inline notice built from
  `capabilityOf(wallet, capability)`:
  - `Unsupported`: name the wallet, give the reason from the matrix
    `caveat`, and name the alternatives. Example for a connected Alby user
    on cat21.space: "Offers are not available with Alby: its signPsbt
    cannot leave the counterparty's input unsigned. Connect Xverse,
    Leather, UniSat, Wizz, OKX, Cat21 Wallet, or use the watch-only path
    to trade." Same pattern for collections (parent/child): plain
    inscriptions work on Alby, the collection action shows the notice.
  - `Proven` with caveat (UniSat/Wizz parent-child): an actionable
    pre-check, not a block: "Switch your wallet's active address type to
    Taproot (P2TR) in the wallet, then reconnect."
- Compose these strings from the matrix (`caveat`, `note`, and the
  wording table below). Never hardcode wallet facts in the frontend: an
  SDK update must change all three sites at once.

## 2. The info icon (required on every wallet row)

Every wallet row in a connect box carries a clickable info icon, on every
site, in the same place:

```
[logo]  Wallet Name  (i)        [Connect] / [Download] / [Export PSBT]
```

- **Placement**: directly AFTER the wallet name, before the row's action
  button. One icon per row, including rows whose action is "Download"
  (wallet not installed) and the watch-only export row.
- **Trigger**: click/tap and keyboard (focusable, Enter/Space,
  `aria-label="What does <wallet> support?"`). Opens a popover or small
  dialog. Never hover-only (mobile).
- **Content, in this exact order**, all sourced from the SDK matrix:
  1. **Header**: the entry `label`, platform badges from `platforms`, and
     a signing-mode line: `injected` = "Signs in your browser",
     `watch-only` = "You sign in your own wallet (Sparrow, Coldcard,
     Ledger, ...)" (full flow: `wallet-picker-watch-only-shared.md`).
  2. **What this action needs**: the current page action's capability and
     this wallet's status for it, using the wording table below.
  3. **Everything this wallet can do here**: all seven capabilities as a
     compact list, each with its status icon and caveat where present.
  4. **Footer**: the wallet-level `note` verbatim.

### Support-level wording (identical on all three sites)

| Matrix value | Icon | User-facing wording |
|---|---|---|
| `Proven` | ✓ | "Verified end-to-end on our test network" |
| `Proven` + caveat | ✓ plus hint | the verified wording, then the caveat sentence |
| `Adapter` | ○ | "Supported, not yet verified end-to-end" |
| `Unsupported` | ✕ | "Not available with this wallet", then the caveat sentence |

### Capability display names (identical on all three sites)

| Capability | Display name |
|---|---|
| `Cat21Mint` | Mint a cat |
| `Cat21Transfer` | Send a cat |
| `Cat21OfferCreate` | Sell (create an offer) |
| `Cat21OfferAccept` | Buy (accept an offer) |
| `Inscription` | Inscribe |
| `InscriptionParentChild` | Collections (parent/child) |
| `SignMessage` | Sign a message |

Each site renders with its own design system (colors, typography, popover
component). Identical across sites: the placement, the structure and
order, the icon semantics, the wording tables, and the data source (the
matrix, never hardcoded).

## 3. Mobile in-app-browser deep links (verified registry)

On a plain mobile browser no wallet provider is injected, so the picker
can't connect. Bounce the user into a wallet's in-app browser via the
SDK's `walletInAppBrowserDeepLink(wallet, targetUrl)` — one shared,
docs-verified registry so the three sites don't each hardcode (and drift
on) schemes:

```ts
import { walletInAppBrowserDeepLink } from 'ordpool-sdk/core';
const link = walletInAppBrowserDeepLink(wallet, currentPageUrl);
if (link) showOpenInWalletButton(link);   // else omit the affordance
```

Only schemes verified against the wallet's official docs are populated
(Xverse today: `https://connect.xverse.app/browser?url=…`, verified
2026-08-26). Every other wallet returns `null` — the consumer hides the
button rather than send the user to a guessed URL. Do NOT hardcode a
scheme in the frontend; if you find a wallet's documented scheme, add it
to the SDK registry (with the doc citation), not to one site.

## 4. Alignment workflow (follow exactly)

1. **Implement your own version** from your handover doc plus this shared
   spec. Then **STOP**. Do not read or modify the sister implementations
   at this stage.
2. **The maintainer reviews** your implementation and gives feedback (the
   second pass).
3. **Only after that review**: cross-check the two sister
   implementations, double-check for drift (icon placement, popover
   structure, wording, disabled-action notices), and **propose** your
   alignment findings to the maintainer: a short list of the differences
   plus which variant should win and why. Do not silently edit a sister
   project.

Sister implementations:

| Session | Repo / path |
|---|---|
| cat21.space | `cat21-indexer/frontend` |
| ordpool.space | `ordpool/frontend` (the `/cat21-mint` page) |
| cubes | `genesis/apps/cubes-frontend` |
