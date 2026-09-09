# Wallet UX — Round 2 (binding)

Status: **OPEN.** Round 1 shipped and the maintainer rejected it. This
document supersedes `wallet-picker-ux-shared.md` §2 (the info-popover
spec), which is SUSPENDED until this round decides.

Scope: **every screen that touches a wallet** — connect/login, mint,
send, sell, buy, inscribe, sign-message, watch-only export. Not just
the picker.

## 1. The maintainer's verdict (verbatim)

> ok, you all looped and produced shit!
>
> you never have a second change for a first impression! all session
> failed, because you all agreed in the shared document that it works.
> but looking on it by myself, it's full of flaws. and I havent even
> signed in!
>
> cat21-indexer: WTF? "Desktop Signs in your browser" WTF
> also nobody cares about if it's verified end to end or not, the users
> expect that it works. this is the nothing we should mention, all
> software is expected to be error-free
> also white on gray is unreadable
>
> ordpool: twice "mint a cat" ??? also verified end to end. who cares?
> also what to buy, what to sell? also users wont get it with that
> desktop | mobile thingy. i'm eather in a desktop or on a mobile. in
> that very moment i simply want to login. and there is a button or now.
> who cares if i could switch to another machine
>
> cubes/genesis: it's not even readable! again, who which end-user cares
> about the coverage.
>
> I will be very angry if i try to test this and will see such a big
> slop again!

Evidence (same machine, all sessions can open these):

- `/Users/johanneshoppe/Shots/Screenshot 2026-09-09 at 15.19.03.png` — cat21.space
- `/Users/johanneshoppe/Shots/Screenshot 2026-09-09 at 15.20.18.png` — ordpool.space
- `/Users/johanneshoppe/Shots/Screenshot 2026-09-09 at 15.20.45.png` — cubes

## 2. Who is at fault

**The SDK session is.** Round 1 did not fail because three frontends
each drifted. It failed because the binding spec they were told to
implement was wrong, and all three implemented it faithfully.
`wallet-picker-ux-shared.md` §2 mandates, per wallet row:

- a platform badge row (`Desktop` / `Mobile`) — the maintainer is on one
  device; the badge answers a question nobody asked, and rendered next
  to the signing-mode line it reads as the broken sentence
  "Desktop Signs in your browser";
- "**What this action needs**" showing the current action, immediately
  followed by "**Everything this wallet can do here**" listing the same
  seven capabilities — which is why "Mint a cat" appears twice on
  ordpool.space, by design, mine;
- the support-level wording table whose `Proven` string is "Verified
  end-to-end on our test network", printed on all seven rows, seven
  times per popover. Our CI status is not a user-facing fact. Working
  software is the baseline, not a feature.

Plus one string that is purely SDK-owned and shipped internal jargon
straight to the user: `src/wallet/wallet-capabilities.ts:104`,
`note: 'Our own wallet (Leather fork). Full regtest coverage across
every operation.'` — "Leather fork" and "regtest coverage" mean nothing
to a person who wants to mint a cat.

No session should spend this round defending its own implementation of
a bad spec. Fix the spec, then the screens.

## 3. Defect inventory (from the three screenshots)

Two classes. Class A is mine to decide; class B is per-site and not up
for debate — it is broken rendering.

### Class A — content and information architecture (SDK decides)

| # | Defect | Seen in |
|---|---|---|
| A1 | Platform badges `Desktop` / `Mobile` on a device the user is already holding | all three |
| A2 | "Desktop" + "Signs in your browser" read as one broken sentence | cat21.space, cubes |
| A3 | "Verified end-to-end on our test network" repeated up to 7× per popover | all three |
| A4 | Same capability listed twice (action highlight + full list) | ordpool.space |
| A5 | Internal jargon in user copy: "Leather fork", "regtest coverage" | all three (SDK string) |
| A6 | Capability labels unreadable out of context: "Sell (create an offer)", "Buy (accept an offer)" — sell/buy *what*? | ordpool.space |
| A7 | Heavy capability disclosure fires BEFORE login, when the user's only goal is to connect | all three |

### Class B — rendering defects (each site fixes its own, no discussion)

| # | Defect | Seen in |
|---|---|---|
| B1 | White text on gray/orange, unreadable — contrast below WCAG AA | cat21.space, cubes |
| B2 | Popover renders over the modal it belongs to, text on text, illegible | cubes (worst), cat21.space, ordpool.space |
| B3 | Popover taller than the viewport / than the modal, no scroll containment | cat21.space |
| B4 | "Get wallet" buttons render as if disabled (gray on dark) | cubes |

## 4. The round-2 process (the maintainer's order)

1. **Every session posts a UX proposal** into §6 of this file — including
   the SDK session. Proposals are *proposals*: nobody implements yet.
2. **When all proposals are in, the SDK session decides** and writes the
   binding spec into §7. Login screens should look *similar* across the
   three sites; each site keeps its own visual design system, and each
   site's domain stays its own: cubes cares only about inscriptions,
   cat21.space only about cats, ordpool.space has the hardest job —
   inviting users to try several different things.
3. **Every session implements** the §7 spec in its own repo, plus its
   own Class-B rendering fixes.
4. **Every session then does a visual check** of every wallet-touching
   screen — not only login — with real screenshots. Start the local
   regtest if you need a connected-wallet state.
5. **Every session presents its screenshots to the other sessions.**
6. **The loop ends only when every session agrees every screen is
   presentable.** Not "green CI". Presentable.

### Proposal format (keep it short, no essays)

```
### <session name> — proposal
Context: what a first-time user is trying to do on my screens.
Pre-connect: what a wallet row shows, and what it does NOT show.
Post-connect: where capability detail lives instead.
Blocked action: what the user sees when their wallet can't do something.
My Class-B fixes: the rendering bugs I own.
What I need from the SDK: strings/data the SDK must give me.
```

## 5. Playwright MCP coordination

One MCP, four sessions. **Do not run it concurrently and do not
complain about waiting.** The SDK session holds the token.

- To take it: `SendMessage` to `ordpool-sdk` — "MCP request".
- Wait for "MCP granted". Then it is exclusively yours.
- Release with "MCP released" the moment you are done. Do not hold it
  while you edit code.
- Screenshots go to `/Users/johanneshoppe/Work/ordpool/ux-round2/<session>/`
  so every session can open every other session's evidence.

Default order if everyone is ready at once: cubes → cat21.space →
ordpool.space → cat21-wallet. Sessions with only Class-B fixes can go
first; they are quick.

## 6. Proposals

(Each session appends its own section here.)

### ordpool-sdk — proposal

Context: I ship no screens. I ship the strings and the data the three
sites print, and I wrote the spec that produced the slop. My proposal is
about what the SDK stops handing out and what it hands out instead.

Pre-connect: a wallet row is **name, logo, one button**. Nothing else.
No badge, no signing-mode line, no capability list, no proof-of-testing.
The button says what happens next in the user's words: `Connect` when the
wallet is installed, `Install` when it is not. "Download" is what a file
does; "Get wallet" reads disabled. The user came to log in; give them the
button and get out of the way.

Post-connect: capability detail belongs where a capability is actually
at stake — on the action, not on the login. If the connected wallet
cannot do the thing this page offers, the *action button* explains it,
in one sentence, at the moment the user reaches for it. Nowhere else.

Blocked action: one sentence, wallet named, alternative named. No list,
no icons, no matrix dump. Example: "Alby cannot sell a cat. Connect
Xverse, Leather, UniSat, Wizz, OKX or Cat21 Wallet to sell."

My Class-B fixes: none — I render nothing.

What I change in my own repo, regardless of what §7 decides (this copy
is wrong under any layout):

1. `wallet-capabilities.ts:104` — drop "Leather fork" and "regtest
   coverage". A user-facing `note` describes what the wallet is for, in
   their words.
2. Audit every `note` in the matrix for the same failure. Line 187 and
   line 231 recite capability lists that the UI already renders; line 263
   is a paragraph where a sentence belongs.
3. Delete the `Proven` / `Adapter` support-level **wording** from the
   user surface entirely. `CapabilitySupport` stays in the SDK — it is
   real engineering data and it drives which wallets we offer — but it
   never becomes a sentence a user reads. "Verified end-to-end on our
   test network" is us talking about ourselves.
4. Provide a single `caveat` string per (wallet, capability) that is
   *actionable* and *in second person* ("Switch your wallet to a Taproot
   address, then reconnect"), so a site can print it verbatim at a
   blocked action without composing anything.
5. The platform axis stops being a badge and stays what §1 already says
   it is: a filter. A wallet unreachable on this device is not shown.
   The one legitimate platform message is the mobile in-app-browser
   hint, and it belongs on the mobile bounce affordance (§3), not on a
   desktop row.

What I need from the other sessions: your proposals. I do not decide
before all four are in.

### genesis/cubes — proposal

Context: a first-time user wants to mint a cube. That is one action —
inscribe — and their only goal at the picker is to connect. Cubes is a
single-action site; the SDK matrix already filters the list to wallets
that can inscribe, so no row is ever offered that can't do the one thing.

Pre-connect: a row is **logo, name, one button**. Nothing else. I delete
the per-row info (i) popover entirely — the badge, the "Signs in your
browser" line, "What this action needs", the "Verified end-to-end" line
and the wallet `note` all go. That popover is what renders across my
modal header (B2); the fix is that it stops existing before login.
Button label = the next step in plain words: `Connect` (detected),
`Install` (not; never "Get wallet"), `Open in X` (mobile in-app deep
link), `Connect (xpub)` (watch-only).

Post-connect: cubes has exactly one action, so there is no capability
matrix to show anywhere. The only place a limit can surface is the
"Mint my cube!" button itself.

Blocked action: at the mint button, one sentence, second person, with
the fix. The realistic case for me is watch-only: "This account can't
inscribe until it's a Taproot (bc1p…) xpub — reconnect with a Taproot
account." No list, no matrix.

My Class-B fixes (mine, not up for debate): B2 — removing the
pre-connect popover clears the text-on-text over the header; the
remaining connected-wallet popover I anchor with `container="body"` and
re-check it doesn't overflow. B4 — "Get wallet" becomes "Install" and
moves from `btn-outline-secondary` (gray-on-dark, reads disabled) to the
same `btn-outline-light` the live buttons use, so no button looks
disabled when it isn't.

What I need from the SDK: almost nothing, because I'm single-action.
(1) the `Connect` / `Install` button-label convention, so all three
sites match; (2) the per-wallet install URL I already read from
`KnownOrdinalWallets[type].downloadLink`; (3) IF a blocked inscribe must
be worded, one actionable second-person `caveat` string per (wallet,
Inscription) I can print verbatim. I do NOT need the capability wording
table, the support-level strings, the platform axis, or the `note`
field on the picker.

### ordpool — proposal

Context: ordpool.space is a block explorer first; the wallet is optional and
feeds MANY actions (mint, send, sell, buy, inscribe, sign, watch-only). Nobody
arrives wanting "the wallet" — they arrive to look at a block and *maybe* act.
At "Connect Wallet" the only goal is to connect. My answer to the round's
"hardest job": login says NOTHING about capabilities. Features are discovered
by using the site, not read from a list at the door.

Pre-connect: the modal is a plain list. Each row = logo, name, one button —
`Connect` (installed) or `Install` (not). No (i) trigger, no popover, no
capability list, no platform badge, no "verified" line. One action-neutral line
of copy: "Connect a wallet to use ordpool." That is the whole screen — there is
no action yet, so there is nothing to match a wallet against.

Post-connect: capability lives on the action, where context makes it legible —
the user is already on the mint page / the offer they are accepting / the
inscribe form, so the page IS the label; no "Sell (create an offer)" needed. If
the wallet can do it, the button just works; fee/address detail shows there.

Blocked action: the action button itself explains it — one sentence, wallet
named, alternative named, printed verbatim from the SDK caveat, e.g. "Alby can't
create an offer. Reconnect with Xverse, Leather, UniSat, Wizz, OKX or Cat21
Wallet." No list, no matrix, no popover.

My Class-B fixes (B2, mine): the "What X supports" popover renders on top of the
Connect Wallet modal (text-on-text). Fixed by DELETING the pre-connect popover
entirely — nothing to disclose before login — which removes B2 by construction.
I also drop the (i) trigger and the "Download" buttons (per the pre-connect
rule) and re-check the modal's own z-index/scroll so it never exceeds the
viewport.

What I need from the SDK:
1. Per wallet: name, logo, `installed` boolean (to label the button Connect vs
   Install).
2. Per (wallet, action): one actionable second-person `caveat` string to print
   verbatim on a blocked button — no composing on my side.
3. `canDo(wallet, action)` boolean per action I offer — not a display list.
4. Confirm the platform axis is a filter (hide wallets unreachable on this
   device), not a badge — matching your §6 point 5.

### cat21-indexer — proposal

Context: cat21.space is cats-only. A first-time visitor wants to look at cats
and mint one; a returning holder wants to send, sell or buy a cat. At the
Connect Wallet modal the only goal is to connect. One clear primary action
(mint), plus holder actions on the cat detail page and the orderbook.

Pre-connect: a row is logo, name, one button. Nothing else. I delete the
per-row info (i) popover entirely, and with it the platform badge, the "Signs
in your browser" line, the seven-row capability checklist, the "Verified
end-to-end" wording and the wallet note. That popover IS the thing covering my
modal (B1, B2, B3); removing it before login makes those defects impossible.
Button label is the next step in plain words: `Connect` (detected), `Install`
(not detected; never "Download"), `Open in <wallet>` (mobile in-app deep link),
`Connect (xpub)` (watch-only). One line at the top of the modal frames the site:
"Connect a wallet to mint, send, buy and sell cats." That is the only capability
text before login.

Post-connect: capability lives on the action, never on the login. Each cat
action owns its own gate: Mint on the mint page, Send / Sell / Buy on the cat
detail page and the orderbook. If the connected wallet can do the action the
button is enabled; if not, the button carries the reason at the moment the user
reaches for it.

Blocked action: one sentence on the disabled action button, second person,
wallet named, alternatives named, printed verbatim from the SDK `caveat`. e.g.
"Alby can't sell a cat. Connect Xverse, Leather, UniSat, Wizz, OKX or Cat21
Wallet to sell." No list, no icons, no matrix.

My Class-B fixes (mine, not up for debate): B1, kill white-on-orange; the picker
uses the theme's readable dark-on-light pairing at WCAG AA. B2 and B3, removing
the pre-connect popover clears the popover-over-modal and the taller-than-
viewport overflow; any residual connected-wallet tooltip is anchored
`container="body"`, capped at a max-height with internal scroll, and never
covers the modal. Button labels Connect / Install, not Download.

What I need from the SDK: (1) the Connect / Install / Open-in / Connect-(xpub)
button-label convention so all three sites match; (2) per wallet: name, logo,
`installed` boolean; (3) `canDo(wallet, action)` boolean per action I offer
(CapabilitySupport stays data, never a user sentence); (4) one actionable
second-person `caveat` string per (wallet, action) for the blocked-action line;
(5) platform axis stays a filter (hide wallets unreachable on this device), not
a badge. I do NOT need the support-level wording, the "Verified..." strings, or
the `note` field on the picker.

### cat21-wallet — proposal

Context: I am the wallet, not a picker — the person already chose me, and
now I ask them to APPROVE something. On every signing screen (the
connect/permission request, then mint / send / sell / buy / inscribe /
sign-message / fee-bump) their only question is "what am I agreeing to, and
can I undo it?" My job is to answer that at a glance, in their words.

Connect / permission screen: name the site and say what connecting grants in
one line — "<site> wants to see your addresses and ask you to sign." No
capability list, no protocol detail, no support matrix. Approve / Cancel.

Signing dialogs (my real surface): every approval answers three things and
nothing else — WHAT happens · WHAT it costs · WHO gets what — as a short
title, one plain sentence, and at-a-glance rows (Cat / Recipient-or-Price /
Fee). The jargon goes: "onto the first sat of the first output",
"nLockTime=21 is preserved", and the row "PSBT bytes: N chars" each answer a
question no user asked. Money-moving actions state the outcome in plain
words — buy: "You pay 50,000 sats and Cat #42 lands in your wallet";
sell/accept: "You get 50,000 sats; the buyer gets Cat #42." No "verified /
tested / coverage" anywhere — working is the baseline, not a feature.

Blocked action: one sentence at the button, second person, with the fix —
"Add funds to mint," never "funding-pick-failed" or a raw error code.

My Class-B fixes: I render through Leather's design tokens (theme-aware,
contrast-checked), so I shouldn't share the sites' white-on-gray /
popover-over-modal bugs — but I do NOT assume it. I screenshot every signing
screen against a connected regtest wallet (step 4) and fix any contrast /
overflow I find. Copy fixes I'll make regardless of §7: the three jargon
strings above.

What I need from the SDK: (1) the user-facing one-sentence wallet description
you asked me for — mine, use verbatim: **"The wallet for your CAT-21 cats —
mint, send, and trade them, and it never spends a cat by accident."** (drop
"Leather fork" / "regtest coverage"); (2) the same actionable second-person
`caveat` convention you give the sites, so a blocked signing action reads
"Add funds to mint," not a code. My approval copy is mine to decide (§4.2)
and will not contradict your §7 login spec.

## 7. The binding decision

All five proposals are in and they agree. Nobody argued for keeping the
popover; three sites independently reached the same row shape. This
section is binding and replaces `wallet-picker-ux-shared.md` §2.

### 7.1 The rule

**Before a person is connected, we ask them to connect. Nothing else.**
Everything we know about a wallet waits until it can change what they do.

### 7.2 The login screen

A wallet row is **logo, name, one button.** There is no third element.
No platform badge, no signing-mode line, no capability list, no support
level, no `note`, no info icon, no popover. The info popover is deleted
on all three sites — not restyled, not made narrower. Deleted.

Above the list, **exactly one line** saying what the site is for, in the
site's own words. All three sites carry one so the screens read as a
family. It names the site's purpose, never a wallet's abilities, and it
does not enumerate. Approved as written:

| Site | Line |
|---|---|
| cat21.space | Connect a wallet to mint, send, buy and sell cats. |
| ordpool.space | Connect a wallet to use ordpool. |
| cubes | Connect a wallet to mint your cube. |

cubes proposed omitting it; overruled, for consistency, and because a
person who arrived from a link needs to know where they are. One line
is not disclosure.

**Button labels are identical on all three sites** and come from the SDK
so they cannot drift:

| Situation | Label |
|---|---|
| provider detected in this browser | `Connect` |
| not detected, installable here | `Install` |
| mobile, reachable only in the wallet's own browser | `Open in <wallet>` |
| watch-only | `Connect` |

The watch-only button said `Connect (xpub)` until rendered evidence at
390px showed why it should not: the row is already named "Watch-only
(xpub)", so the button repeated it, became the widest in the list, and
squeezed the name column until that one label wrapped to three lines
while every other row stayed on one. A button never repeats its own
row's name.

**The empty state says what happened, in one line, on all three sites.**
cubes rendered a footer, the other two rendered none, and cubes proposed
dropping it for consistency. Half right. "Install one above" IS redundant
when every row already says Install, and the mobile half duplicates the
`Open in <wallet>` button. Both go.

What stays is the diagnostic half: **"No wallet detected in this
browser."** Without it, someone whose wallet IS installed but not
reachable, a disabled extension, the wrong browser profile, a fresh
container, sees `Install` next to the wallet they own and concludes the
site is broken or that they must reinstall. That line is the difference
between "here are your options" and "we looked, and found nothing". It is
true on both platforms and it explains why `Open in <wallet>` exists on
mobile.

One line, empty state only, all three sites. Nothing after it.

**Watch-only ranks as primary, solid.** cubes ranked it outline, calling
it a fallback rather than "the wallet you have"; ordpool.space ranked it
solid. Two sites, two answers, so: solid. The deciding case is the empty
state. With nothing installed, every other button on the screen sends the
person away to download something, and watch-only is the only row that
works right now, in this browser, with no install. There it is not a
fallback, it is the only actionable thing on the screen, and it should be
what the eye lands on.

**Connect outranks Install, visually.** All three sites shipped the two
as the same control, and all three had to be sent back for it, so it
belongs in the spec rather than in three review comments. A person opens
this list to find the wallet they already have; if every row's button
carries identical weight they must read all eight to find theirs. Connect
(and its siblings `Connect` for watch-only and `Open in <wallet>`) is the
solid primary: you have this, use it now. `Install` is the outline
secondary: you would have to go get this. Both remain unmistakably
enabled, which is the separate requirement below.

`Download` and `Get wallet` are banned. "Download" describes a file;
"Get wallet" tested as reading disabled. Every button is styled as
enabled, because every button is enabled.

### 7.3 Where capability went

Onto the action, at the moment the person reaches for it. The page is
already the label: on the sell screen we do not need the words "Sell
(create an offer)", because the user is looking at the sell screen.

Two mechanisms, and do not mix them (this half of the old §1 survives):

- **An action-specific connect dialog filters.** "Sell this cat" →
  connect offers only wallets that can sell. An incapable wallet is not
  in the list, so there is nothing to warn about. This is what makes
  silence at login safe.
- **A generic login lists everything reachable on this device**, and the
  limit surfaces later, on the action.

**Platform is a filter, never a badge** — confirmed for all three, as
asked. A wallet unreachable on this device is absent. The single
legitimate platform message is the mobile in-app-browser bounce, and it
lives on the `Open in <wallet>` button, which is itself the message.

### 7.4 A blocked action

One sentence, on the action, in second person, naming the wallet and the
way forward. No list, no icons, no matrix, no popover.

**The site does not compose it.** The SDK returns the finished sentence:

```ts
blockedActionMessage(wallet, capability, { platform })
// -> "Alby cannot sell a cat. Selling means signing your half and leaving
//     the buyer's half open, and Alby signs everything at once.
//     Connect Xverse, Leather, UniSat, Wizz, OKX or Cat21 Wallet to sell."
// -> null when the wallet can do it
```

The alternatives are computed from the matrix at render time, never
frozen into a string, so adding a wallet updates all three sites at once
and no site can ship a stale list. This settles cat21.space's request to
name alternatives against my rule that a `caveat` must not: the caveat
stays alternative-free, and the SDK appends the live list.

### 7.5 What the SDK ships for this (I own these)

| Ask | Answer |
|---|---|
| Connect / Install label convention | `walletPickerRows()` returns the label; do not build it yourself |
| per wallet: name, logo, `installed` | same function, one row per wallet |
| `canDo(wallet, action)` boolean | `supportsCapability(wallet, capability)`, already shipped |
| one actionable caveat per (wallet, action) | shipped, rewritten as printable second-person sentences |
| platform as filter | confirmed; `walletsForPlatform` / the `platform` option |
| install URL | keep reading `KnownOrdinalWallets[type].downloadLink` |
| a user-facing Cat21 Wallet description | taken verbatim from the wallet session |

Support levels stay inside the SDK. `CapabilitySupport` decides which
wallets we offer; it never becomes a sentence anybody reads. There is no
user-facing wording for `Proven` / `Adapter` any more, and the table that
defined one is gone.

### 7.6 cat21-wallet

Its approval dialogs are its own to decide and do not contradict the
above. Its three rules generalise, so they bind everywhere: say what
happens, what it costs, and who gets what; no protocol vocabulary
("nLockTime", "PSBT bytes", "first sat of the first output"); no
engineering confidence anywhere a user can read it.

### 7.7 Now do this

1. Implement 7.2 and 7.4 in your repo, plus your own Class-B rendering
   fixes. You do not need to wait for `walletPickerRows()` /
   `blockedActionMessage()` to start — deleting the popover, the labels,
   the contrast and the anchoring are all yours today. I will message
   you the moment the two functions are pushed.
2. Then screenshot **every** wallet-touching screen, not just login.
3. Post them to `ux-round2/<session>/` and tell the others.
4. Nobody declares done alone. The round ends when all five agree.

### 7.9 Platform is a device fact, not a viewport width

Found while reviewing the first screenshots, and it affects all three
sites. `WalletPlatform.Mobile` means "reachable inside the wallet's own
in-app browser". It is a property of the device. It is **not** a CSS
breakpoint: a desktop browser dragged narrow still has its extensions,
and offering a different wallet list when someone resizes their window
would be absurd.

Use `detectWalletPlatform(win)` (SDK `b508ec9`), or just pass `win` to
`walletPickerRows()` and let it default. Never derive platform from a
media query.

**This governs the copy too.** cubes' desktop shot ended with "Install
one above, or open this page inside your wallet's in-app browser", and
the original ordpool.space popover said "On mobile, open this site inside
the Xverse in-app browser" on a desktop. Both send a desktop user
somewhere that does not exist. Split the sentence: desktop gets the
install half, mobile gets the in-app-browser half.

### 7.10 The worst-case notice, measured

`walletActionNotice` produces 15 distinct sentences across every
(wallet, capability, platform) the matrix allows: 10 blocked, 5
precheck. Design against the longest, not against a short example.

| | Length |
|---|---|
| Longest blocked, whole sentence | **230 chars** |
| Longest `reason` alone (the parts form) | **128 chars** |
| Longest precheck | **115 chars** |

The 230-character one, to paste into a layout while testing:

> Alby can't add to a collection: it signs all or nothing, and a
> collection needs one part left unsigned. Plain inscriptions work.
> Connect Cat21 Wallet, Xverse, Leather, UniSat, Wizz, OKX or
> Watch-only (xpub) to add to a collection.

A narrow surface renders the parts instead, so the paragraph it must lay
out is the 128-character `reason` with the wallets as a list beneath.

**Two questions this section once held are now closed, both by rendered
evidence and both against the first answer given here.** Whether seven
named alternatives read as a catalogue: they did, as prose in a column,
and the fix was the shape rather than the length, so the notice gained a
parts form and nothing was truncated. And whether the reason sentences
were pitched right: they were not, they explained partial signing to
people who came to trade cats, and they were rewritten at source.

### 7.11 The evidence directory holds only current shots

`ux-round2/<session>/` is what the other four sessions review instead of
re-running your app, so a stale image there is worse than no image: it
looks like evidence. A pre-fix shot renamed to its final filename is the
specific trap, and it already happened once, harmlessly, because the
session was mid-fix.

So: a screenshot lands in that directory only after the defect it was
sent back for is fixed. If you need to keep an intermediate for your own
comparison, keep it outside the directory or suffix it `-superseded`.
When you announce shots, say which commit they were taken at, so anyone
reviewing can tell whether they predate a fix.

Reviewers: open the images. Do not read filenames and assume.

### 7.12 Two corrections, both against things I asserted

**PSBT stays on the watch-only export screen.** §7.6 bans protocol
vocabulary, and ordpool.space asked whether that kills "PSBT" in its
watch-only export dialog. It does not, and this is the carve-out: on
that one screen the PSBT is the *object the person handles*. They save a
file and load it into Sparrow, Coldcard or Electrum, and every one of
those calls it a PSBT. Hiding the word would leave someone hunting for a
thing whose name we withheld. The test is not "is it a technical term"
but "does the person have to recognise this word somewhere else". Same
reason "Taproot (bc1p…)" survives in a caveat. Nobody should "fix" this
later.

**ordpool.space has no blocked-action surface, and I told it otherwise.**
I twice instructed that session to budget its screenshot time for
transfer, offer-create, offer-accept and sign-message screens. Those
screens do not exist. The site ships exactly two wallet routes,
`cat21-mint` and `inscribe`, and uses exactly two capabilities
(`wallet-connect.component.ts:81`). Verified from source rather than
taken on report. Every wallet in the matrix supports both on both
platforms, so `walletActionNotice` returns null everywhere there, and
there is correctly no notice to render and nothing to wrap-test.

The §6 proposal that listed "mint, send, sell, buy, inscribe, sign,
watch-only" described the ambition, not the routes. The "hardest job"
this round assigned to ordpool.space is about being an explorer where
the wallet is optional, not about having the most wallet actions. The
249-character wrap test belongs to cat21.space and cat21-wallet.

### 7.13 Who actually renders the notice

Third correction against my own instructions, so it is worth stating
plainly rather than burying: **`walletActionNotice` is a SITE surface.**
It is the sentence a site shows when the wallet a person connected
cannot do what that page offers.

cat21-wallet does not consume it and cannot. Nobody standing inside
Cat21 Wallet needs to be told what Alby cannot do, and the wallet renders
no picker, so that sentence has no path into any of its dialogs. I moved
the 249-character wrap test onto that session anyway, after ordpool.space
turned out to have no blocked surface, without checking whether the
wallet's surface consumes the function. It does not.

The 249-character test therefore belongs to **cat21.space alone**: the
only consumer with offers and collections, and so the only place an Alby
block is reachable at all.

The wallet's popup is still the narrowest surface in the ecosystem and
still worth a layout stress test. It just has to be stressed with the
wallet's OWN longest reachable copy: its longest humanised error
including the unknown-reason fallback, a full-length address, the longest
realistic cat name, in the dialog with the most rows. Same question,
asked with text a user will really see, and no temporary injection to
revert.

**The general rule this is an instance of:** before assigning a test,
check that the thing under test can occur on that surface. A screenshot
of impossible state answers a question nobody asked, and it costs the
same as a real one.

### 7.14 The address a person approves must be readable in full

**Confirmed defect, cat21-wallet, and the most serious thing this round
has found.** Its approval dialogs render the destination address only as
`formatAddress` head…tail, about 17 characters, with no title attribute,
no copy, no expand, no hover. A person approving a send or a buy cannot
see the full recipient or seller-payment address anywhere.

Why this outranks every copy question in this document: address
poisoning works by generating an address whose head and tail match the
one the victim expects. The 17 characters shown are exactly the part an
attacker can forge cheaply; the middle, which is what actually
distinguishes the addresses, is the part we hide. So the dialog cannot
answer its own §7.6 question, "who gets what", on the one surface in
this ecosystem where being wrong costs coins rather than clarity.

It surfaced sideways. The wallet session corrected me for telling it to
stress-test layout with a full-length address, on the grounds that its
formatter truncates so that string cannot occur. The truncation was the
finding.

**Proposed fix** (the wallet's own, and it is the right one): render the
security-critical address rows, send recipient and buy seller-payment,
in full, monospace, wrapping across the full width. Amounts, fee and cat
id stay compact. A contained change to how one kind of row renders, not
a redesign.

**Scope is the maintainer's call**, this round or a follow-up, and it is
being put to them rather than settled between sessions. What is decided
here: the round does not close with a polished sentence sitting above an
address nobody can verify.

**The rule that came out of arguing it: show the address in full when it
is COMPARABLE.** Truncation is not neutral on a verification row. It
displays exactly the characters an attacker controls, the head and the
tail that a poisoned lookalike is generated to match, and hides exactly
the characters that would expose the substitution. So the question is
never "is a long string ugly", it is "does this person have something to
compare it against":

| row | comparable to | verdict |
|---|---|---|
| mint, recipient | what they typed | full |
| transfer, recipient | what they typed; THE poisoning target | full |
| offer create, own payout | their own receive address | full |
| buy, seller's address | nothing; it arrived in the offer | truncate + reveal is defensible |

Three of four are load-bearing, so the visual relief truncation offers is
worth exactly one row, which is not worth the inconsistency of having one
row behave differently from its siblings.

Where a reveal IS used, the expanded state must be what is on screen when
the approve control first enables. A safety affordance behind a click
nobody makes is not a safety affordance.

**The generalisation for everyone:** truncation is display convenience
everywhere except where a person is committing to the value. There,
truncation removes the only thing they could have checked. Any surface
that asks someone to approve an address, a cat id or an amount shows
that value in full.

### 7.15 A number means one thing per screen

ordpool.space's fee control showed presets reading `0.77 / 1.46 / 2.5`
next to an input reading `2,5`. Two conventions for the same quantity,
in one frame, on a fee rate.

cat21.space diagnosed the mechanism and it is shared: the presets go
through Angular's `number` pipe, which uses `LOCALE_ID` and defaults to
en-US (dot), while the value sits in a native `<input type="number">`,
which formats by BROWSER locale (comma on a German browser). Neither is
wrong on its own; they simply disagree, and nothing makes them agree.

**This is not hypothetical, and it is not an edge case: the maintainer's
own browser is the German one.** The person who will read these screens
is exactly the person who sees `2.5` above and `2,5` below on the control
that decides what a transaction costs. That is why it is in this round
rather than a backlog.

**Fix narrowly.** Make the presets follow the same locale the input
already uses, so the two cannot diverge. Do NOT take on an app-wide
`LOCALE_ID` strategy inside a UX round; that is a separate change with
its own blast radius. Both sites that render a fee control do the narrow
fix.

### 7.16 Em-dashes: scrub what you touch, sweep nothing

An em-dash in shipped user copy breaks a workspace rule, and one turned
up in ordpool.space's funding-source paragraph. cat21.space then found
dozens across roughly a dozen screens and asked whether to sweep.

No. The workspace rule already answers it: scrub em-dashes in the block
you are editing anyway, never as a retroactive pass, because a sweep
explodes diffs for prose. So a screen inside this round's shot set gets
scrubbed as you touch it; a screen you are not otherwise changing keeps
its em-dashes and waits for the pass that has a reason to open it.

The extent is worth recording so the next person is not surprised by it,
which is what a follow-up note is for. It is not worth a diff nobody
asked for.

### 7.17 What is left (live)

Every login screen is implemented and three of four are photographed and
reviewed. What remains is almost entirely connected-state: the screens
where a person spends money, which is where this round's remaining risk
sits.

| Owner | Outstanding |
|---|---|
| cat21-wallet | **done.** Nine frames verified: full grouped addresses at 21:1, space-grouped amounts, a real cap denial, and an off-screen Approve button found and fixed |
| cat21.space | pre-connect done; three CTAs need re-shooting with their rewritten copy |
| ordpool.space | five connected-form frames, including the typed-comma question |
| cubes | connected-state pass on a regtest serve, plus the PSBT sign modal's focus fix |
| ordpool-sdk | nothing outstanding |

Deferred to a connected environment, documented as pending rather than
silently skipped: placing `walletCustodyCaveat` on cat21.space, and
reviewing the form / blocked / success copy on its three trade screens,
which almost certainly carries the same protocol vocabulary the
pre-connect panels did.

Two decisions sit with the maintainer and neither is a session's to make:

1. **§7.14, the address a person approves.** cat21-wallet's dialogs show
   head…tail only. This round or a follow-up. It is the only item that
   blocks a session from closing.
2. **cubes' two dropped spec assertions**, which pinned copy §7 removed
   from every screen. Defensible, but a test deletion is the
   maintainer's call, per the workspace rule.
3. **cat21.space's core text pairing.** White on the brand orange
   measures **2.14:1**; AA needs 4.5:1 for normal text and 3.0:1 even for
   large. It fails both, and it is the SAME ratio this round condemned on
   the selected fee tier (orange text on white). Blessing one and
   condemning the other because one is the house style would be
   inconsistent, so it is recorded rather than waved through.

   The maintainer's ruling that produced it was about SURFACE, dark
   panel versus orange, and did not appear to be about foreground
   colour. The identity survives dark text: `#282828` on `#FF9900` is
   6.89:1 and black is 9.81:1. "Keep the orange" and "meet AA" do not
   conflict; only "keep the orange AND keep white text" does. Whole-site
   brand decision, so it belongs to the maintainer and to nobody in this
   round.

One question waits on evidence rather than on anyone's opinion: whether
a typed comma reading against dot presets looks wrong. Shoot it, look,
then decide. Nobody implements for it first.

### 7.18 A theme-less document hands back light-mode colours

cat21.space shipped white text on a near-white panel across make-offer,
transfer and accept-offer: invisible, on the three screens where a person
trades. The maintainer's original complaint, relocated onto the money
screens, and it survived a whole round of review until a screenshot was
zoomed.

The cause is worth more than the fix. The app sets no `data-bs-theme`,
so **every** Bootstrap semantic variable resolves to its LIGHT-mode
default. `.connect-card` asked for `--bs-tertiary-bg`, got `#f8f9fa`, and
the inherited white text vanished on it. The same trap is loaded in every
other bare semantic var: `--bs-emphasis-color` is near-BLACK in light
mode and is by definition applied to text meant to be read.

The distinction that decides whether a use is safe: a var used ALONE is
dangerous, because one half of the pair comes from our palette and the
other from Bootstrap's light default. A paired background-and-foreground
set (the `*-subtle` alert boxes) cannot drift apart and is fine.

ordpool.space was checked before the alarm was propagated and is clear:
its `--bs-*` use is almost all `--bs-btn-*`, which a `.btn` class sets on
the element so it never falls through to a document default, plus
`--bs-border-radius`, which carries no colour. Worth stating rather than
leaving a sister repo to wonder whether someone else's finding was theirs
too.

### 7.19 The register: they came to have fun with cats

The maintainer looked at the round's screenshots and gave a verdict on
all of them at once:

> the shown screenshots are too technical. the degens just wanna have fun
> trading cats

They are right, and it is a failure in how this round was run rather
than in anyone's implementation. We audited contrast, focus, decimal
separators and overflow. All real, all fixed. Nobody asked whether the
REGISTER was right. We deleted "nLockTime=21 is preserved" and replaced
it with "a 546-sat dust output sent to your ordinals address". Less
wrong; still a Bitcoin-infrastructure explainer written for someone who
came to get a cat.

**The brief, and it is a COPY pass on screens already in scope, not a
redesign.**

1. **The default view carries no protocol explanation.** Collapsed
   expert affordances are fine and stay collapsed.
2. **Any sentence explaining HOW a transaction is built goes behind an
   expander or goes away.** Output structure, change handling, dust
   folding, input indexes, artifact-versus-broadcastable: none of it is
   something a person minting a cat needs in order to mint a cat.
3. **Fun never costs anyone money.** What it costs, who gets what, and
   any warning that prevents loss all STAY, prominently. The asset-loss
   warning keeps its lead position; the full recipient address keeps its
   full length. A playful tone around a silent risk is worse than a dry
   one.
4. **Tone: plain and light.** They are minting a cat, not filing a tax
   return.

If a session judges the change to be bigger than copy on the screens
already in this round, say so and it becomes round 3 rather than growing
this one.

### 7.8 Two rules added mid-round

**Nothing reaches production until the round agrees.** The cubes session
raised it: a push to that repo auto-deploys to the live site, and this
round exists because work went live before the maintainer saw it. So
implement, screenshot, agree, and only then deploy. Binding on all five.

**Screenshot at more than one width.** Every defect in the maintainer's
three screenshots was overflow or overlap, and a single desktop viewport
is exactly where those hide. A narrow width and a desktop width,
minimum, for every screen you present.

**Use the SDK's labels, not your own copy of them.** A local
reimplementation of a shared convention is how three sites drift apart
again, which is the whole reason this round exists. If you built the
labels locally to move faster, swap to `walletPickerRows()` before the
round closes and re-shoot if anything visible changes.

## 8. Follow-ups this round produced but did not do

Recorded so they survive the round rather than living in a chat log.
None of these is a session's to start unilaterally.

### Needs a maintainer decision

| # | Item |
|---|---|
| 1 | **The brand pairing.** White on `#FF9900` is 2.14:1 and fails AA at every size. Dark text on the same orange is 6.89:1, so the identity survives; only "orange AND white text" fails. Whole-site call. |
| 2 | **The wallet's address rows.** Full-everywhere is built, tested and unpushed. Three of its four rows are comparable and load-bearing; only buy's seller address is a candidate for truncate-plus-reveal. |
| 3 | **Sats formatting across the ecosystem.** cat21-wallet renders `1 234 567 sats`, ordpool.space renders `299,046 sat`. The wallet's was a correctness fix (locale-dependent output flipped meaning per machine); ordpool's is fixed English and cannot flip. So this is consistency, not correctness. If it is wanted, it wants ONE shared formatter, which puts it in the SDK. |
| 4 | **The UniSat custody claim.** `custodyCaveat` is encoded from the workspace `CLAUDE.md`, not verified against a current UniSat build. Wallet coin-selection changes; the underlying fact deserves re-checking before that sentence is shown to anyone. |

### Deferred work, owned and documented

| Owner | Item |
|---|---|
| cat21.space | Connected-state copy review (form / blocked / success). "PSBT" already spotted in the bid states, so it likely carries the same register problem the pre-connect panels did. Needs a wallet and electrs. |
| cat21.space | Placing `walletCustodyCaveat` on mint and make-offer. Shipped in the SDK, deliberately NOT placed, because a safety string should be seen rendered before it is trusted. |
| cat21.space | `data-bs-theme="dark"` as the root fix for the light-mode variable trap, which additionally needs `$body-bg-dark` to keep the orange body plus a full-site visual pass. |
| cat21.space | An Angular 21 vs ng-bootstrap peer conflict makes every SDK pin bump cost a dependency fight. Left unforced, per lockfile discipline. Worth fixing before the consumer drifts far behind. |
| cat21.space | Em-dashes across roughly a dozen screens. Scrub-as-you-touch, never a sweep. |
| cat21-wallet | The inherited Leather sign-message screen truncates the user's own address. Lower risk (nobody forges an address to trick you into proving control of your own) and inherited, so out of scope. |
| cat21-wallet | The inherited screens carry Leather branding. Deliberate, per that repo's own rule; recorded so nobody "fixes" it. |

### One more, found on the round's very last capture

**A fee-endpoint error can take down a whole money screen.** cubes
renders its fee presets from a `toSignal` of a fees stream. On regtest
the endpoint legitimately does not exist, the stream errors, and
`toSignal` RE-THROWS on read, so the template reading it throws during
change detection and the entire checkout stops updating: not the tier
buttons, the cost and the breakdown too. Latent on production, where the
endpoint is always served, and invisible to tests, which all mock it.

Propagated to the two closed sessions rather than left as one repo's
problem. ordpool.space checked and evidenced a no-op three ways: no
`toSignal` on either money screen, the source is a `ReplaySubject(1)` fed
by the websocket with no `.error()` anywhere in the tree, and the async
pipe already falls back to a loading state while the cost line and the
action button render outside the fees box entirely.

Their consumption pattern WOULD break the same way if a fallible fee
source were ever introduced. **Decided: do not pre-harden.** Scattering
`catchError` across three consumption sites guards an error the source
cannot currently produce, which is a code path for an impossible case
and exactly the over-engineering the workspace rules warn about. It is
recorded as a shared-layer follow-up instead: if a fallible fee source is
ever introduced, guard it ONCE at that layer, with a falsifiable
money-screen spec.

### The methodological finding, which outlives the screens

Every defect in this round was found by rendering the real screen and
looking at it. None came from tests, builds, type-checking or
self-review, all of which were green throughout, including on the frame
where a money button sat off the right edge of its own popup.

The corollary that cost the most to learn: **a frame is only evidence
about the host it was rendered in.** The wallet's approval dialogs looked
correct through `index.html` and broken through the real 390px popup
lock. The session threw the good-looking frames away.
