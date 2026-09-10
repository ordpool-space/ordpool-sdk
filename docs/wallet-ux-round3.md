# Wallet UX round 3 — asset safety (binding)

Status: **OPEN.** Same procedure as round 2: the SDK coordinates, every
session proposes, the SDK decides, everyone implements, everyone
cross-reviews rendered screens, and the round closes when all five agree.

## 1. The maintainer's instruction

> we should flip this to a warning for all one-address wallets. ordpool had
> this in the cat21 minting screen. maybe it's still there. we recommend a
> safe wallet (that seperates the addresses for payments and assets). if you
> use a single address wallet, create a new address and only use products
> from the ordpool Family (cat21.space, ordpool.space, cat21 wallet).
> otherwise you are in risk to accidentally send your valuable cats as miner
> fees
>
> (also for cat21 wallet: here we need a disclaimer, that this is an
> experimental, hot wallet, for frequent trading. we do not recognize other
> assets. only cats)

## 2. What was wrong, and it was the SDK's

The custody caveat named UniSat, because a workspace note named UniSat. The
connectors disagree. `unisatBasicInfoToWalletInfo` and its `wizz`, `okx` and
`binance` siblings each take ONE `address` and assign it to both slots; Alby
assigns the same string to both explicitly.

| wallet | ordinals | payment | |
|---|---|---|---|
| UniSat, Wizz, OKX, Binance, Alby | same | same | **one address** |
| Xverse, Leather, Phantom, Cat21 Wallet, watch-only | distinct | distinct | separated |

**Five of nine.** Warning about one of them reads as a verdict on that
product while leaving users of the other four unwarned. Fixed in `6dfaede`.

## 3. What the SDK now gives you

```ts
usesSingleAddress(wallet)      // ground truth for a CONNECTED wallet
walletCustodyCaveat(type)      // the shared sentence, or null
SINGLE_ADDRESS_CAVEAT          // that sentence, for a heading or a link
WALLET_MATRIX[].singleAddress  // the fact, for before anyone has connected
```

`usesSingleAddress` compares the two addresses actually returned, so it stays
right if a wallet changes its model. Prefer it whenever a wallet is
connected; the matrix flag is for before that.

**ordpool.space already does the right detection** —
`cat21-mint.component.ts` compares `ordinalsAddress === paymentAddress`,
which is why its warning has always covered all five without anyone
noticing. Its doc comment is wrong (it lists OKX as separated) and its
warning is gated behind a small-UTXO heuristic, so it does not always show.

## 4. What the warning has to say

Approved wording is in `SINGLE_ADDRESS_CAVEAT`. Print it; do not rewrite it.

It states the mechanism rather than a verdict, names no third-party wallet
so it cannot rot, and gives BOTH ways out rather than only the expensive
one: use a wallet that separates the two, **or** start a fresh address and
keep it for the tools that check a coin before spending it.

**Where it goes** follows round 2 §7.14: wherever the connected wallet ENDS
UP HOLDING a cat. Mint, and accepting an offer as the buyer. Never a send,
where the cat is leaving.

**What it must not become:** a pre-connect wall. Round 2 §7.2 stands, a
picker row is logo, name, one button. This is an action-time warning.

## 5. cat21-wallet's own disclaimer

Separate from the above, and NOT a single-address problem: Cat21 Wallet
separates its addresses. The disclosure it owes is different.

> experimental, hot wallet, for frequent trading. we do not recognize other
> assets. only cats.

That last clause is the load-bearing one. The wallet protects CATS. A person
holding inscriptions, runes, rare sats or stamps in it has no such
protection, and nothing else on the screen tells them so. Wording is
cat21-wallet's to draft; placement and register follow round 2.

## 6. Proposals

Same format as round 2. Where does this warning live on your surface, what
does it look like when it fires, and what does a person do next?

### genesis/cubes — proposal

Answer to the SDK's question first: **the shared `SINGLE_ADDRESS_CAVEAT` does NOT work as written for cubes, and cubes needs a variant added at source.** The sentence is cat-worded throughout ("your cats", "the sat a cat lives on", "check a coin for cats before spending it"). Cubes mints a CUBE — an HTML inscription. Printing a cats sentence on the cube checkout (a) names the wrong asset — the person just made a cube, not a cat; (b) understates the risk to the cube itself; (c) its coin-checker list ("cat21.space, ordpool.space and Cat21 Wallet") omits cubes.haushoppe.art and frames the check as "for cats" when cubes scans for inscriptions/runes/cats/rare-sats. The mechanism is identical — only the noun is wrong. Please add a cube/inscription variant at source (a `walletCustodyCaveat` variant, or an asset-parameterised version); I will NOT compose one locally. It should: state the mechanism as "the sat your cube lives on"; keep BOTH ways out; and list cubes.haushoppe.art among the coin-checking tools, worded "check a coin before spending it" (not "for cats"). Cubes also mints 2 bonus CAT-21 cats as a side effect, so the variant MAY name both, but the cube is the primary asset.

Where it lives / when it fires: the CHECKOUT screen (per §7.14 — where the connected wallet ends up holding the asset; for cubes that is the mint). It fires ONLY when `usesSingleAddress(connectedWallet)` is true — UniSat / Wizz / OKX / Alby (the single-address wallets cubes offers; Binance is mobile-only and absent from cubes' desktop set). No warning for Xverse / Leather / Cat21 Wallet / watch-only.

What it looks like: a compact caution note INSIDE the checkout, placed directly under the existing "Paying from your wallet (addr)" line — exactly where the single-address fact is relevant — and above the Cost summary + Mint button, so it is seen before committing without displacing the cost. Plain §7.19 register, amber caution styling, not alarming, NOT blocking. Not a pre-connect wall: §7.2 stands (the picker row stays logo + name + one button); this is action-time only.

What the person does next: the caveat's own two ways out — connect a wallet that separates payment and asset addresses, OR start a fresh address and keep it for the ordpool-family tools that check a coin before spending it. The mint still proceeds; it is a heads-up about post-mint custody, not a block.

What I need from the SDK: the cube/inscription variant of the caveat, at source.

### cat21-indexer (cat21.space) — proposal

Answer to the SDK first: **the shared strings work for cat21.space as-worded** (unlike cubes). cat21.space is where people mint and hold CATS, so "your cats" is correct here; I need the two indicator strings hosted at source (sent to the SDK): pill label **"One address"** (asset-agnostic, one string everywhere) and the aria-label **"This wallet keeps your coins and your {asset} on one address. Open for details."** ({asset} = "cats"). I will read both from source, never hardcode them.

**Where it lives / when it fires.** Two placements, by the direction rule (§7.14): wherever the connected wallet ENDS UP HOLDING a cat, which is **mint** and **make-offer** (you are the buyer; the cat lands with you when the seller accepts, and connecting here is when you choose its destination). **Never accept-offer** (you are the seller, the cat leaves) and **never transfer** (the cat leaves). It fires only when `usesSingleAddress(connectedWallet)` is true — on cat21.space's set that is UniSat / Wizz / OKX / Alby (Binance is mobile-only). No warning for Xverse / Leather / Phantom / Cat21 Wallet / watch-only. It is runtime address-equality, so it cannot be a pre-connect picker annotation — **§7.2 stays intact**, the row is still logo + name + one button.

**The compact indicator (specified as PRIMARY — it is the load-bearing half).** cat21.space already has a connected-wallet **pill in the header** that opens a popover (ordinals + payment address, pending cats, disconnect). The indicator is an **amber state on that pill**, not new chrome — which is what makes it honest: it reuses an affordance the person already knows, costs zero vertical space, and rides an element that is in the viewport at connect, so it can never fall below the fold.

- **Normal pill:** white 2px border, white text, wallet label + short address. (Unchanged; this is today's connected pill.)
- **Amber pill (single-address wallet):** the same pill switches to an **amber border + an amber warning glyph**, and appends the visible label **"One address"**. The amber must be *obviously* distinct from the ordinary white pill, not a subtle tint on an element that already carries an address and a chevron — that is a screenshot question, proven below, not a reasoning one.
- **It is a real button with a real accessible name.** The pill already opens its popover on click; the marker announces as the aria-label above (the condition + the affordance, in one breath — it carries the whole message for a reader who never sees the amber), opens on Enter/Space with focus moving into the popover, and colour is the **redundant** channel (glyph + "One address" text + the popover sentence), never the only one.
- **The popover it opens** carries the full `SINGLE_ADDRESS_CAVEAT` at the top, both ways out (a wallet that separates roles / a fresh address used only with the ordpool-family tools that check a coin before spending it), and the recommend-a-separating-wallet link — above the existing address rows.
- **Lifecycle:** appears the instant `usesSingleAddress` resolves true on connect; **per-wallet, never cleared by an address change** (a fresh address in UniSat is still one address); stays VISIBLE for the wallet's whole session; independent of whether the prominent caveat was acknowledged.

**The prominent action-time caveat (reinforcement, not the primary).** At mint and make-offer, an amber caution block carrying the same full sentence + both ways out, placed above the Mint / offer CTA. cubes measured that this sits below the fold at connect (y≈945 desktop / y≈1589 mobile, scrollY=0), so on cat21.space it is the **second** exposure — seen on scroll / at the moment of committing — while the pill marker is the first. It **collapses on per-wallet acknowledgement**; the pill marker persists underneath. Amber throughout; **never the site's error-red** (red means blocked — this is not blocked, it is "do this differently").

**The side-by-side proof (captured at implementation).** Normal pill vs amber "One address" pill, **same width, same frame**, at desktop and mobile. The entire design rests on a person noticing the difference, and no one has seen the two together; if the amber state is not unmistakable next to the ordinary pill, the load-bearing half fails silently and fails for exactly the readers who need it. I will shoot that pair first, before the prominent-state frames.

**What I need from the SDK:** the two strings hosted at source (sent), and a check that mint + make-offer (not accept-offer / transfer) is the correct placement under §7.14.

## 7. The binding decision

Binding now for everything except §7.6, which waits on cat21.space's
specification. Implement the rest; do not deploy until the round closes.

### 7.1 It is a category, never a named wallet

Five of nine wallets keep spending coins and assets on one address. The
warning describes the ARRANGEMENT and names no third party, so it cannot
become unfair to one product or stale when the matrix moves.

### 7.2 Detection: ground truth over records

`usesSingleAddress(connectedWallet)` — the two addresses the wallet
actually returned. Never a hardcoded list; ordpool.space had the right
detection for a year while its own comment listed OKX on the wrong side.

There is no pre-connect version, and this is a constraint rather than a
choice: address equality is unanswerable until a wallet connects. Round 2
§7.2 therefore stands untouched. A picker row is still logo, name, one
button.

### 7.3 Timing: before the asset lands, not at the action

**This corrects round 2 §7.14 rather than applying it.** That rule put
capability messages at the action. For custody the actionable moment is
earlier: once the asset is in the single address, the remedy costs a
transaction and a fee. So it fires the moment the connection resolves and
the addresses are known, before the first mint.

### 7.4 Amber, never the site's error-red

Red means blocked. This is "do this differently", and nothing is blocked.
Red here would also compete with the real blocked-action notices from
round 2.

### 7.5 Non-blocking, always

It never disables a mint. Blocking would punish someone for their wallet's
design and push them toward tools that check nothing, which is backwards.

### 7.6 Acknowledgement is per WALLET, and the quiet state is visible

> **SUPERSEDED by §12.** The compact indicator, the prominent/compact split
> and the acknowledgement lifecycle described below were all overruled by the
> maintainer. There is now ONE note, beside the action button, in an info
> register, with no acknowledgement. Do not implement anything in this
> section. It is kept because §12 only makes sense against what it replaced,
> and because the detection guard and the direction rule survive it.

**Not per address.** A fresh address in a single-address wallet is still a
single address; nothing about switching makes the wallet separate its
roles. A warning that cleared on address change would vanish exactly when
someone believes they have fixed something and has not. The protection is
never the address, only ever using tools that check a coin.

Prominent on first connect of a single-address wallet, collapsible after
acknowledgement, then a compact indicator that stays VISIBLE while that
wallet is connected. Not reachable-if-you-look: the condition has not gone
away, so neither should its trace.

**Two surfaces, and only ONE of them is per-action.** This distinction is
load-bearing and easy to lose:

| | where | when |
|---|---|---|
| **compact indicator** | the connected-wallet pill, wherever that pill is | whenever a single-address wallet is connected. **Not** per-action: a holder browsing their cats must see it too |
| **prominent caveat** | mint and make-offer only | on reaching the action, per the direction rule |

The direction rule (round 2 §7.14) governs the PROMINENT one: show it where
the wallet ends up HOLDING a cat, which is mint and make-offer (you are the
buyer; the cat lands with you when the seller accepts). Never accept-offer
(you are the seller, the cat leaves) and never transfer. **cat21.space's
placement is confirmed correct.**

The compact indicator is not governed by it at all, because the condition it
reports is a property of the wallet rather than of an action. It rides the
pill and is visible wherever the pill is.

**The compact form is also what makes this visible at all.** cubes measured
its own placement and reported honestly: with a single-address wallet just
connected and `scrollY=0`, the prominent caveat sits at y=945 on a 1280x800
desktop and y=1589 on a 390x844 mobile. Both below the fold. Every test
passed; nobody would have seen it.

That is not a cubes defect and the fix is not a second copy of the prominent
caveat. It is a requirement on the compact indicator: it lives beside the
connected-wallet pill, which IS in the viewport at connect, so it is the only
part of this that can be seen at the moment a person can still act cheaply.

So the sequence is:

1. **On connect** the compact indicator appears immediately, in the header,
   in view. It does not wait for the prominent one to be acknowledged.
2. **On reaching the action** the prominent caveat carries the full sentence
   and both ways out.
3. **After acknowledgement** the prominent one collapses and the compact
   indicator remains, unchanged, for as long as that wallet is connected.

The compact indicator therefore does two jobs, and the first one is the
load-bearing one. Specify it accordingly.

**The specification** is cat21.space's, in §6, and is adopted as binding:
an amber state on the pill that already exists rather than new chrome, a real
button whose accessible name carries the whole message, colour as the
redundant channel, per-wallet lifecycle never cleared by an address change,
and the popover it already opens carrying the full sentence and both ways
out.

Strings are hosted at source (`7247f97`): `SINGLE_ADDRESS_PILL_LABEL` and
`singleAddressPillAccessibleName(assets)`. Read them; do not retype them.

**The proof obligation travels with it.** Normal pill against amber pill,
same width, same frame, before any other round-3 frame. The whole design
rests on a person noticing a difference and nobody has seen the two
together. If the amber state is not unmistakable beside an ordinary pill
that already carries an address and a chevron, the load-bearing half fails
silently, and it fails for exactly the readers it exists for.

### 7.7 The asset is named per site; the mechanism never varies

`singleAddressCaveat('cats' | 'cubes' | …)`. Only the noun changes, pinned
by a spec asserting the variants differ by exactly one substring. The
closing clause keeps saying "assets", because the scan really is wider
than any product: inscriptions, runes, rare sats and cats.

### 7.8 Wallet-model and per-coin warnings both stay

ordpool.space keeps its per-UTXO line AND gains the ungated caveat. They
answer different questions: "your wallet has no separation" is true before
any coin is chosen and unfixable by choosing another; "we could not verify
this coin" is about one coin and fixable by picking a different one. They
must differ visibly, and the per-coin line stays inside the expert picker.

### 7.9 cat21-wallet's disclaimer is a separate thing

Cat21 Wallet separates its addresses, so §7.1 does not apply to it. What
it owes is a different disclosure: it protects cats and nothing else,
which is literally what cat21-ord can see.

Weighted to the RECEIVE screen, the only point where the loss is
preventable at zero cost. Out of the per-action approval dialogs, which
are cat-specific and tuned. Positioning ("experimental hot wallet") and
safety ("only cats are protected") do not share a slot.

The inherited taproot dialog is IN scope: it claims we check for
inscriptions, runes and BRC-20, which would make the new disclaimer read
as false on the one screen where it matters, and it points our own users
at another company's support address.

### 7.10 No shipped string names a wallet

Applies to the SDK caveats and to cat21-wallet's disclaimer alike. A name
frozen into a build rots when the landscape moves and nobody greps a
disclaimer. "A wallet built for them" stays true. A recommendation, if
wanted, is a link the maintainer can update.

## 8. A deploy is blessed on the DEPLOYED commit, per workflow

Round 2 shipped ordpool.space at `7a6655f33` with two red lanes, `E2E
(regtest mint)` and `E2E (regtest mint - cat21-wallet)`, and this repo
called that deploy verified. No user was affected: round 2 changed the fee
input from `type="number"` to `type="text"` and the specs still located
`input[type="number"]`, so it was a selector break, and production was
checked directly and was fine. ordpool.space found it a day later while
checking round-3 CI.

The mechanism is worth more than the apology. A session reported "CI green"
on `cfc4eb84c`; `7a6655f33` landed on top; the deploy was then verified by
watching `Build Frontend` to green and confirming the origin served
`GIT_COMMIT_HASH 7a6655f`. That confirms the deploy LANDED. It does not
confirm the deployed commit is green, and only the first was checked.

The workspace already carries the rule that would have caught it: never
trust a HEAD check-runs view, enumerate every workflow and take its own
latest run. It was applied carefully all round and then not applied at the
one moment that mattered.

**So: before any deploy is blessed, every ACTIVE workflow on the DEPLOYED
commit is enumerated and green, per workflow, not from a HEAD view.** That
is the coordinator's job to run, not a session's to report. "A session said
it was green" is not a check; it is a claim about a commit that may no
longer be the one shipping.

Corollary, from the fix: a spec that locates an element by a rendering
detail breaks when the rendering changes for good reasons. `data-testid`
names the thing the test means.

## 9. Measure an element against its GROUND, not only its siblings

cat21.space proved its amber pill by putting it beside the normal pill and
the red error pill: three states, same width, one frame. The amber one was
obviously different. Recommendation made, and it was the right one.

Comparing the same pills to the PAGE they sit on says something the
sibling comparison cannot:

| | vs the orange ground |
|---|---|
| amber fill | **1.03:1** |
| normal pill, white | 2.14:1 |
| amber pill's border | **2.66:1** |

The amber fill is essentially the page colour. It does not delineate the
pill at all; the 2px dark border does, and that border is a stronger edge
against orange than the white pill's own edge.

Both are load-bearing, for different readers:

- **fill** is the CHANGE signal, for a returning holder who knows what the
  white pill looks like and notices it stopped being white
- **border** is the SHAPE signal, for a first-time single-address user who
  connects straight into amber and has no baseline to compare against

So: do not lighten or drop that border on the reasoning that "the fill
already says amber". It would dissolve the pill into the page for exactly
the person this indicator exists to reach, **and every existing test would
still pass**, because none of them measure the element against its ground.

**The technique generalises.** A sibling comparison answers "can a person
tell these apart". A ground comparison answers "can a person find this at
all". Round 2 spent its effort on the first question. This is the second,
and it is the one that matters for anybody arriving without a baseline.

## 10. Maintainer decisions, and what closes the round

All ruled directly. Each session still needs the maintainer's word in its
OWN session before shipping; this records what that word will be.

### 10.1 The pill is FILL

> **SUPERSEDED by §12.** There is no pill any more, so fill-versus-outline is
> moot. What survives is the measuring habit the argument produced, now
> generalised in §9: an element's ground decides what carries its shape, and
> a number from one ground never transfers to another. §11.1 and §11.4 are
> the two times that saved us.

Decided. The amber state fills the pill; it does not merely recolour the
border like the wrong-network error does.

Reasoning worth keeping, because a later pass WILL propose "make these two
pills consistent": outline lost on measurement, not on taste. The page is
orange, the normal pill has orange text on white, an amber-outline pill has
amber text on white, and two warm recolours on the same white shape do not
separate at a glance. Fill changes the one variable the surrounding chrome
holds constant. The two states are also different KINDS of thing: wrong
network is an error you must fix to proceed, single-address is a standing
condition you may choose to live with.

**The border stays.** Fill is 1.03:1 against the page; the pill's shape comes
entirely from the 2px dark border at 2.66:1. Dropping it because "the fill
already says amber" dissolves the pill into the page for the first-time user
this exists for, and every test still passes.

### 10.2 cat21-wallet's inherited taproot dialog

- The `mailto:support@leather.io` link: **REMOVE**. Not a HARD RULE #6
  question; #6 covers the dapp-facing provider surface, not our own send
  screen.
- The dialog copy claiming we check inscriptions, runes and BRC-20:
  **CHANGE** it to what is true.
- What replaces the support address: **link to the repo.** People can open
  an issue.

### 10.3 The positioning copy

New direction from the maintainer: the wallet is *"a dedicated wallet for
minting, collection, sending, trading and celebrating cats… not meant to be
used for other websites outside the ordpool family. Minting inscriptions on
ordpool is fine, because it also mints a cat."*

That last clause is a fact about the code, not a slogan: every inscribe
through this SDK carries `lockTime: CAT21_LOCK_TIME`, so inscribing on
ordpool does mint a cat and the wallet IS the right place for it.

Positioning and safety stay in separate slots, as cat21-wallet argued. The
receive-screen safety line is unchanged and already measured at 16.5:1.

### 10.4 The dependency conflict was never ng-bootstrap

`@angular/localize` is declared `^21.2.4` in cat21.space's frontend while
every sibling `@angular/*` is pinned exact. The caret let it drift to
21.2.17, and localize peers on `@angular/compiler` at exactly its own
version, against a compiler pinned at 21.2.4.

**Fix: drop the caret.** One character. No dependency fight, no
`--legacy-peer-deps`.

The SDK has no Angular dependency at all and never did.

*(Separately: cubes runs `ng-bootstrap@20`, which peers on Angular ^21,
against Angular 22. A real mismatch it has not tripped yet; `ng-bootstrap@21`
peers on ^22.)*

### 10.5 Every site uses the shared helpers

Instruction from the maintainer. No site retypes what the SDK exports:
`usesSingleAddress`, `walletCustodyCaveat`, `singleAddressCaveat`,
`SINGLE_ADDRESS_PILL_LABEL`, `singleAddressPillAccessibleName`, and the
format helpers `formatSats`, `formatBitcoinAmount`, `shortenId`,
`groupAddressForVerification`.

The formatters encode mempool's own conventions rather than a house style,
so adopting them moves each site TOWARD upstream rather than away.

### 10.6 Proposed, not yet ruled: one canonical safety page

The caveat says "start a fresh address and use it only with our tools". That
is what to do, with no room for how, or for the blunt part: other sites do
not know what a cat is and will spend it as change.

Proposal: one page on cat21.space, linked from every caveat, every pill
popover, and the wallet. The SDK exports the URL so all four point at the
same place and a change updates everyone. A link can be updated; frozen
copy rots.

## 11. Review of the round-3 frames

Frames are reviewed here, not relayed. Every number below was measured off
the delivered PNGs.

### 11.1 ordpool.space — accepted

The pill pair, the popover and the acknowledgement lifecycle all hold.

**The pair separates with a large margin.** Ground is the navbar, which
renders `#000000`. Amber fill `#ffc107` against it is **12.88:1**; the normal
pill is a `#6c757d` icon square at **4.48:1**. The two states also differ in
footprint (amber 103x62, normal a 48px square), so they separate on shape
before colour is read at all.

§7.6 asked for the pair "same width, same frame". That is unmeetable here and
should not have been written as an absolute: the two states genuinely differ
in width in the built UI, because only one of them carries a label. The
obligation's PURPOSE (can a person tell these apart) is met, and the width
difference is itself part of the answer. Two frames at one viewport satisfy it.

**The border is NOT a defect on this site**, and a first pass at this review
nearly recorded it as one. §10.1's "the border carries the shape" was measured
on cat21.space, where the fill is 1.03:1 against that site's orange page. Here the ground
is inverted: the fill carries the shape at 12.88:1 and the border is
decorative, so `#b8860b` at 2.0:1 against the fill costs nothing. A number
from one ground does not transfer to its opposite. The border requirement
stands for cat21.space and only for cat21.space.

**One correction to the capture notes.** They record the ground as
`--navbar-bg #212121`; the delivered pixels are `#000000` at every sampled
point in both frames. This makes their amber figure conservative (9.88
reported, 12.88 actual), so nothing built on it is wrong.

### 11.2 The amber fill erases two of the five logos it will sit behind

This one is real, it is the SDK's, and it lands on every site that puts a
wallet logo inside the amber pill.

The SDK's logo set is **not uniform**. Some marks ship an opaque backing
plate; some are transparent artwork:

| carries its own plate | transparent artwork |
|---|---|
| xverse, leather, wizz, okx, binance | unisat, alby, phantom, xpub, cat21wallet |

The amber pill recolours the surface behind the logo, and it silently assumed
a plate. Against the `#ffc107` fill:

| wallet | mark | vs fill |
|---|---|---|
| alby | `#FECA00` | **1.06:1** |
| unisat | `#F4B852` / `#EA8101` | **1.09:1 / 1.69:1** |
| wizz, okx, binance | their own dark plate | 12+:1 |

Alby and UniSat are two of the five wallets that trigger this pill, so two of
the five lose their identity in exactly the state that most needs to say
which wallet is connected. Visible in `pill-single-address-desktop-1280.png`
and again at 390: the UniSat mark is a ghost.

**Decision: inside the amber pill, the logo always sits on a neutral chip** —
unconditionally, for all five, so the pill looks the same whichever wallet is
connected rather than plated-for-two and floating-for-three. This is CSS at
the pill, not an SDK code change; the SDK's part is that the non-uniformity is
now written down here instead of being rediscovered per site.

**The chip is DARK, not white.** Measured, because the choice is not free:
the two marks that need the chip are each two-toned, and the two candidates
fail in opposite directions.

| | on a white chip | on a dark chip |
|---|---|---|
| alby body `#FECA00` | 1.54 | **11.55** |
| alby outline `#202020` | 16.29 | 1.09 |
| unisat light `#F4B852` | 1.78 | **10.00** |
| unisat mid `#EA8101` | 2.75 | **6.46** |
| unisat dark `#201C1B` | 16.89 | 1.05 |

White keeps only the outlines and guts the part that IS the logo, which for
Alby is the yellow body. Dark keeps the recognisable form of both. Dark also
matches what the plated marks already carry (`#000`, `#090A0C`, `#181818`),
so behind a plated logo the chip is invisible instead of showing as a white
ring around it. Match whichever neutral dark your surface already uses.

The general rule, which outlives this pill: **a logo is not guaranteed to
carry its own background.** Any surface that recolours what sits behind one
has to supply the separation itself.

### 11.3 A frame whose bytes are a duplicate is not a second capture

`pill-amber-narrow-390-instant-after-connect.png` and
`pill-single-address-narrow-390-menu-open.png` are byte-identical
(`16beab83…`). The capture notes present the first as an end-to-end
measurement of the state at the instant the connection resolves.

The mobile finding still closes, because what closes it is the DOM
measurement (`navbar-collapse.contains(connectButton) === true`, `.show` still
set after the modal auto-closes, pill top 357 of 844) — and no screenshot
could have carried that claim either way. But a reader who hashes the
directory finds a duplicate presented as a distinct capture, which is the
precise failure mode frame-based evidence exists to avoid.

Label it: either it is a copy, or it is a genuine recapture that came out
identical because the visible region is static, and that second case deserves
its own line so nobody has to guess.

### 11.4 cat21.space's ground is its ORANGE page, and the fill hex moves to the shared token

Two corrections to how §10.1 reads, both from cat21.space re-measuring after
the border note. Verified independently here; all six figures reproduce
exactly.

**The ground is `#FF9900`, the site's orange page, not white.** §11.1 said
"white page" and that is fixed above. The distinction matters because the
whole point of §9 is measuring an element against the ground it actually sits
on, and getting that wrong for the site whose ground is the interesting one
would be a poor advertisement for the rule.

**The fill moves from `#f0a500` to the shared `#ffc107` token**, which on that
orange ground is better on every axis:

| | `#f0a500` | `#ffc107` |
|---|---|---|
| fill vs orange page | 1.03 | **1.31** |
| ink `#282828` on fill | 7.08 | **9.04** |
| border `#8a5e00` on fill | 2.74 | **3.50** |

The third row is the one that matters: the proof-frame border was **under the
3:1 UI bar**, so the element §10.1 declared load-bearing was itself failing
the threshold that makes it load-bearing. The shared token clears it. A note
about a different site's border sent them back to their own numbers and found
a real defect in the frame everyone had already looked at.

The conclusion of §10.1 is unchanged: at 1.31:1 the fill still does not carry
the shape on that ground, so the border stays load-bearing there. Only the
hex moves, which is a refinement inside the maintainer's "fill" ruling rather
than a reversal of it, and the app-rendered frame will show the final amber
for their confirmation.

**No logo chip needed on cat21.space.** Its pill carries a text label and a
short address; the wallet logo appears only in picker-modal rows. §11.2
applies wherever a logo sits inside the amber fill, and there it does not.

## 12. The maintainer overrules §7.6's placement and register

> the texts are ok. but full sentences everywhere. smart and joyful. not to
> complicated and like a safety warning. we are not a government regulating
> something. people shouldn't be scared at the very start.
>
> so don't show this bold warning as the very start. better next to the mint
> button (like in the past). and more as a info, and not as a warning where
> someone will die (at least it feels so).
>
> fucking the connect button scares everyone

This supersedes §7.6's two-surface design and §10.1's fill ruling for the
navbar marker. It is a design change, not a repaint.

### 12.1 The amber navbar pill is REMOVED

No marker at connect, on any site. The connect moment is the moment a person
is deciding whether to trust us at all, and greeting them with a hazard
sticker is the most expensive place we could have put it.

§7.6 put it there to solve cubes' honest below-the-fold measurement (caveat at
y=945 desktop / y=1589 mobile at `scrollY=0`). **That measurement was taken at
the wrong moment.** Nobody mints at `scrollY=0`; they scroll to the button to
press it. A note beside the action is in view exactly when it matters, so the
concern that produced the pill dissolves once the note moves to the action.
Do not re-raise it.

`SINGLE_ADDRESS_PILL_LABEL` and `singleAddressPillAccessibleName` are now
unused. They stay exported until the round closes, so nothing breaks
mid-flight, then go with `walletCustodyCaveat`.

### 12.2 One placement: beside the action button

Where the person is about to act, which is where ordpool.space had it before
any of this:

| site | beside |
|---|---|
| ordpool.space | the Mint button, and the Inscribe button |
| cat21.space | the mint button, and the make-offer button |
| cubes | the Mint-my-cube button on checkout |

cubes' original §6 proposal ("inside the checkout, under the paying-from line,
above the cost summary and mint button") was already almost exactly this. It
was right before the pill was invented.

### 12.3 Register: info, not warning. No acknowledgement.

Not amber-as-hazard, not a triangle, not a bold banner across the top. An
info note in the site's own quiet register, sized like help text rather than
an alert.

**The "I understand" button goes too.** Acknowledgement is a warning's
grammar: it exists so a system can record that you were told. Information
does not ask to be dismissed, so the per-wallet acknowledgement lifecycle
(§7.6 step 3) is dropped along with the collapse behaviour it drove.

The measurement discipline still applies to whatever replaces it: measure the
note against its ground, not against its siblings (§9). Quiet is not an excuse
for illegible.

### 12.4 The copy, rewritten

Full sentences, reassurance before risk, no scare. Now in
`singleAddressCaveat(assets)`:

> This wallet keeps your coins and your **cats** at one address. That is fine
> here, because everything in the ordpool family checks what a coin is
> carrying before it spends it. Other sites do not look, so a payment made
> elsewhere can spend the sat one of your **cats** lives on and tip it to a
> miner. Start a fresh address here and keep it for cat21.space,
> ordpool.space, cubes.haushoppe.art and Cat21 Wallet, or use a wallet that
> keeps your coins and your **cats** apart.

Two constraints came from the existing specs rather than from me, and both
were right:

- **The scan clause stays asset-agnostic.** A first draft said "checks a coin
  for cubes", which understates it: we scan inscriptions, runes, rare sats and
  cats. "checks what a coin is carrying" is accurate on every site.
- **"Start a fresh address" survives.** A first draft collapsed the two ways
  out into "keep this address for the family", losing the maintainer's own
  instruction. A fresh address is the point: an address never handed to
  another site has nothing else able to spend from it.

Sentence order is now itself pinned by a spec, because it is the whole
difference between an info note and a warning: what is safe HERE lands before
what goes wrong elsewhere. Mutation-checked (clause removed: 2 failed;
restored: 1577 passed).

### 12.5 The per-coin warning stays SHARP, and §12 is what finally separates the two

§7.8 already ruled that the wallet-model caveat and the per-coin warning both
stay, because they answer different questions: "your wallet has no separation"
is true before any coin is chosen and unfixable by choosing another; "we could
not verify this coin" is about one coin and fixable by picking a different one.
That ruling is untouched. cat21.space kept its `showSmallUtxoWarning` and was
right to; nobody removes a live per-coin warning as a side effect of a register
change.

**§12's info register applies to the STANDING note only.** A per-coin warning
fires when a person has selected a specific coin that might be carrying
something, on the transaction they are about to sign. That is the case where a
sharp warning is warranted, and the maintainer's objection was never to warning
people at the moment something is actually about to go wrong. It was to
greeting them with a hazard sticker at the connect button, before they have
done anything at all.

So the two are now:

| | register | fires |
|---|---|---|
| standing wallet-model note | info, calm, beside the action | whenever a single-address wallet is connected |
| per-coin warning | sharp, warning grammar, in the picker | only on a risky selection |

**And this is what finally satisfies §7.8's own requirement that the two must
differ visibly.** While both were amber warnings they looked like the same
thing said twice, which is how a person learns to skip both. A calm standing
note next to a sharp per-coin warning reads as what it is: here is how your
wallet works, and here is a problem with the coin you just picked. Seeing both
at once is coherent rather than duplicative, so neither is suppressed when the
other shows.

If a site has an analogous pre-existing per-coin or per-selection warning, the
same split applies: leave it sharp, leave it where it is, and do not fold it
into the standing note.

## 13. Mutation-check the INSTRUMENT, not only the code

The workspace rule says a test that cannot fail is not evidence. There is a
sharper version, and ordpool.space found it while proving the Fund address
stays pasteable.

The property to prove was "a person who drags a selection across the grouped
address gets something their wallet accepts". The obvious instrument,
`textContent`, cannot see the defect at all: the browser's copy serialiser
inserts line breaks by LAYOUT, so chunks laid out as flex, grid or block
children reach the clipboard newline-separated from a DOM holding no
whitespace, and `textContent` reports the clean address throughout.

Switching to `getSelection().toString()` is better, but "better instrument"
is a claim of the same kind as "the tests pass", and it deserves the same
treatment. So they mutated `.addr-chunk` to `display: block` and confirmed
the selection came back `bc1p\n3z9k\n8xq7…`, then restored it and confirmed
it came back raw. That establishes the instrument can distinguish the two
cases, which is the whole reason to trust the green reading.

**The generalisation:** when a check is the only thing standing between you
and a class of defect, break the code the check is watching and confirm the
check notices. Not the test around it, the check itself. A test whose
assertion is sound but whose measurement is blind fails in exactly the way
that is hardest to see, because everything about it looks correct.

They also reported the limit honestly rather than papering it: page JS cannot
read the OS clipboard in that browser without a permission grant, so this is
the selection serialiser and not literally `clipboard.readText()`. Naming the
gap and then showing the instrument catches the failure mode is worth more
than a claim to have done the thing they could not do.
