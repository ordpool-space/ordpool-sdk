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
| watch-only | `Connect (xpub)` |

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
