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

## 7. The binding decision

(SDK session writes this once every proposal is in. Empty until then.)
