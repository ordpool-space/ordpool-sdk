# Round 5 — the connect button (BINDING)

The maintainer, with a reference screenshot from ord.net:

> connect button! this is how it looks on ord.net. Wallet icon + connect.
> we want the same, on all pages. every page is allowed to have their own icon
> (ordpool uses the current icon set, cat21.space uses something pixelated,
> cubes can decide what looks nice). the heading is everywhere
> "Connect a wallet"

and, to the SDK:

> coordinate that task, to all session, i will tell them to accept your order

## 1. What every site builds

**The button**: a wallet icon, then the word `Connect`. Nothing else. Not
"Connect wallet", not "Connect a wallet" on the button itself.

**The panel it opens**: heading `Connect a wallet`.

The two are one sentence across the click. The button omits the noun because
the icon is already carrying it; the panel says it in full, because by then
the icon is gone from view.

## 2. Strings come from the SDK, the ICON does not

```ts
import {
  CONNECT_BUTTON_LABEL,            // "Connect"
  CONNECT_PANEL_HEADING,           // "Connect a wallet"
  CONNECT_BUTTON_ACCESSIBLE_NAME,  // "Connect a wallet"
} from 'ordpool-sdk';   // or 'ordpool-sdk/core'
```

**Why these are shared when a tagline is not** (§9 of round 4 drew that line):
a tagline is MEANT to differ per site, so it belongs to its repo. These are
MEANT to be identical. Someone who connects on cat21.space and then on cubes
should meet the same two words rather than two attempts at them. The test is
not "is it copy", it is "is variation the point here".

**The icon is explicitly per-site**, by the maintainer's own instruction.
ordpool.space uses its existing set, cat21.space something pixelated, cubes
whatever suits it. A shared SVG would fight three design languages to save
nothing, because nobody reads an icon on two sites and notices it differs.

## 3. The accessible name is NOT the visible label

`CONNECT_BUTTON_ACCESSIBLE_NAME` is "Connect a wallet" while the visible label
is "Connect". This is deliberate and the two must not be collapsed.

The bare verb works visually ONLY because the icon sits beside it carrying the
noun. A screen reader gets no icon, so a button announced as "Connect" alone
has lost the word that said what it connects. Put the accessible name on the
button (`aria-label`) and mark the icon decorative (`aria-hidden`), or the
icon's own alt text ends up read as part of the name.

A spec fails if anyone sets the two equal, in either direction.

## 4. What this replaces

Whatever each site calls its connect control today. ord.net's is the
reference for the SHAPE (icon, then verb, quiet weight), not for its colours
or its icon.

`walletPickerRows()` already returns `actionLabel: 'Connect'` for each ROW
inside the panel. That is a different control from the page's connect button
and is unchanged; do not confuse the two while wiring this.

## 5. Measure it, as always

The button is the entry point to every signing flow on the site, so it is the
one control a person must not fail to find. Measure the label and the icon
against their ground, per round 3 §9, and remember that quiet is a register
rather than a contrast budget: ord.net's reference renders grey on near-black,
which is a look, not a licence to go below the floor.
