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

*(cat21.space is specifying it. That spec lands here.)*

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
