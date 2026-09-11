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

## 6. The wallet skips this round, and the reason sharpens the rule

cat21-wallet has no connect-a-wallet button and should not grow one, for the
same structural reason it has no footer: it IS the wallet. Asked to check
rather than assume, they found their only two connect-shaped strings and
showed both are the INVERSE act:

- `open.ts`: "Permission denied, user must first connect to the wallet", the
  error when a dapp calls before approval. The dapp is the one connecting.
- The dapp-permission screen ("CONNECT APP, Requested by <origin>"): a site
  asking to connect to the wallet, the wallet approving.

Their conclusion, which is better than the question that prompted it:

> Adopting the family connect strings there would mislabel the act. It would
> read as if the wallet is offering to connect to something, when it's the one
> being connected to.

**The general rule, worth more than the instance: a shared string names an
ACT, and the inverse act must not borrow it.** Two surfaces can both be about
"connecting" and still need different words, because the subject differs. The
sameness that justifies hosting is sameness of the act, not of the topic.

That is the third cut through the same question this fortnight, and the three
compose:

| | test | example |
|---|---|---|
| round 4 §9 | is variation the POINT? | tagline varies by design, so local |
| round 5 §2 | is variation the point? | connect strings must match, so shared |
| round 5 §6 | is it the SAME ACT? | a wallet being connected TO is not a visitor connecting one, so separate words |

## 7. Colours and weight MAY vary; the shape and the wiring may not

The maintainer, asked whether cat21.space's filled white button should be
quietened to match cubes' and ord.net's:

> Die Farben dürfen variieren. Die eine Seite ist orange, der Rest dark. Da
> darf es variieren.

So the A/B is released. One site sits on orange and the rest on dark, and a
treatment that works on one ground does not transfer: a grey ghost button is
ord.net's look on near-black and is the 2.14:1 trap on `#FF9900`. Each site
adapts to its own ground, as in round 4 §7, where "similar" meant structure
rather than hex.

**Do not re-coordinate this dimension.** cat21.space's filled block and cubes'
quiet button are both correct, for the same reason their footers differ in
colour while matching in structure.

### What still does NOT vary

- Wallet icon, then the bare verb `Connect`. Nothing else on the button.
- Panel heading `Connect a wallet`.
- All three strings from the SDK constants, never retyped.
- `aria-label` = `CONNECT_BUTTON_ACCESSIBLE_NAME`, DISTINCT from the visible
  label, with the icon `aria-hidden`.
- Measured against its own ground. Text owes 4.5:1, the icon owes 3:1 as a
  non-text element, and "quiet like ord.net" is a look rather than a licence
  to go under the floor.

The lesson worth keeping from the round-4 footer applies unchanged: share the
structure, adapt the surface. What made the footer read as one family was the
same shape in three palettes, not the same palette in three places.
