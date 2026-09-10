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
