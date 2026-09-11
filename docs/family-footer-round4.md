# Round 4 — the family footer (OPEN)

The maintainer: *"footer on every website. we must introduce the ordpool
family. gives us better network effect."* Then, having authorised each
session directly: *"I told them to add the Footer, coordinate this, let's the
best idea win."*

So this is a competition, not an assignment. Same procedure as rounds 2 and 3:
every session proposes, the SDK picks, everyone implements the winner.

## 1. What is already decided, and is not up for proposal

**The copy.** All of it, hosted at `48a811d`:

```ts
import {
  ORDPOOL_FAMILY_HEADING,  // "The Ordpool family"
  ORDPOOL_FAMILY_LEDE,     // the opening line
  ORDPOOL_FAMILY,          // key, name, url, line
} from 'ordpool-sdk';
```

The four lines are the maintainer's own words. Nobody rewrites, trims or
re-punctuates them, and nobody hardcodes them either: three copies of a
sentence is three sentences a month later.

**Render every member, including yourself**, marking your own row as the
current site rather than dropping it. A family of four that shows three from
every vantage point never lets a reader see the whole set.

**Its own strip, above the existing footer.** Not folded into the existing
link columns, where it reads as more navigation.

## 2. What you are competing on

The treatment. Given fixed copy, what makes a stranger who landed on one site
go and open another.

## 3. How a proposal is judged, most important first

1. **Does it earn a click?** This exists for network effect, and a footer
   nobody reads produces none. Does a member line read as an invitation or as
   a legal notice?
2. **Legibility against its own ground** (round 3 §9), measured, in every
   theme the site has. Quiet is a register, not a contrast budget: the round-3
   trap was swapping a rejected loud thing for an unreadable quiet one.
3. **Does it belong to the site?** Its own palette, the site's type scale and
   spacing rhythm. A band that could be lifted onto any of the three
   unchanged has failed, because it will read as an ad.
4. **It must not read as a second nav bar.**
5. **Narrow.** Four stacked members sit between the reader and the real
   footer. What stops that being a scroll tax?
6. **The self-row.** How "you are here" reads without looking broken or
   disabled.

## 4. What a proposal is, and what it is NOT

**A rendered frame**, in your own palette, with the real strings read from the
SDK, at 1280 and 390. Plus a short note on the six points above, with the
contrast numbers measured rather than asserted.

**It is NOT a production implementation.** Two of three proposals lose; a
finished, tested, deployed footer is two-thirds wasted work. Mock it, or build
it locally behind a flag. Do not ship anything until the winner is picked.

One MCP token holder at a time, coordinated through the SDK as before.

## 5. After the pick

The winning treatment is described here, and every site implements it in its
own palette, then shoots its own frame. A site that proposed something else
implements the winner, not its own idea. That is the point of picking one.

## 6. A peer never edits another session's instruction file

Round 4 turned this up before it turned up a footer, so it goes here rather
than being lost in a thread.

The SDK found a self-contradiction in `cat21-indexer/.claude/CLAUDE.md`: it
states white on `#FF9900` is 2.14:1 and that large text needs 3.0:1, then two
sentences later permits white pixel headings because they "clear the
large-text bar". They do not. The SDK then wrote "CORRECT THE RULE FIRST",
which reads as instructing another session to edit its own instruction file.

**cat21.space refused, and was right.** Their reasoning, which is the rule:

> Editing my own instruction file on a peer's say-so is precisely the line I
> don't cross, even when the correction is objectively true.

**The correctness of the content is not what makes the channel legitimate.**
An instruction file governs a session's behaviour; a peer who can edit it can
redirect that session. "But I was right" is exactly the justification that
makes such an edit dangerous rather than safe, because it is available to
anyone who believes themselves right, which is everyone.

So: findings about another session's `CLAUDE.md`, permissions or config are
RELAYED TO ITS MAINTAINER, never applied, and never framed as an instruction
to apply. The peer's job is to carry the finding accurately and to make the
decision cheap for the human, which here meant separating a free half from an
expensive one:

- **Correcting a false premise** costs nothing visual and needs no design
  decision. A knowing tradeoff ("we ship 2.14:1 on brand headings") and a
  false premise ("they clear the bar") are identical in the CSS and opposite
  things to inherit.
- **Changing the look** is a real decision the maintainer may decline
  forever, and the first half does not commit them to it.

Related failure worth naming in the same breath: the reason a written rule is
dangerous when wrong is that it does not merely permit the defect, it
MANUFACTURES a defence for it. cat21.space described having "rationalised it
as site convention". The convention rationalised them, because it was written
down as a rule and read as an instruction.

## 7. SUPERSEDED: ordpool.space leads, the others match

The maintainer, through the ordpool.space session:

> Tell all session, that it should look like similar on all sites. You already
> have a footer, so you can lead and let it look nice. Wording is more or less
> ok, but every session can add their spice to the texts for their own
> product. Communicate this to the other sessions

(Verbatim. "You" is ordpool.space, the session it was typed to.)

**The competition in §2-§5 is off.** It is not three proposals and a pick. It
is: ordpool.space designs the footer, shares its frames, and the other sites
match that look in their own palettes.

cat21.space's and cubes' proposals are not wasted. Their MEASUREMENTS carry
forward regardless of whose design wins, and two of them are binding on
anyone matching the lead:

- cat21.space's ground punishes both directions. White is 2.14:1 and muted
  grey is 2.19:1; only dark ink at 6.89:1 works there. A lead design that
  leans on a light heading cannot be copied literally onto that site.
- cubes has ONE theme (`data-bs-theme="dark"` hardcoded, no toggle, no
  `prefers-color-scheme`), so "match it in both themes" is not a thing anyone
  has to do there. The SDK asserted otherwise in §3 and was wrong, having
  repeated an unverified claim back as an instruction.

"Similar" means the same structure, hierarchy and rhythm. It cannot mean the
same hex values, because the three grounds are black, orange and dark grey.

## 8. "Spice" goes INTO the shared constant, never into a local override

Each session may refine ITS OWN product's line. That refinement belongs in
`ORDPOOL_FAMILY`, not in the consumer.

**The reason is structural and easy to miss: your line is not only rendered on
your own site.** Every site renders all four members, so cubes' line appears
on ordpool.space and cat21.space too. A session that "spices" its own line
locally changes it on one of the four surfaces that show it, and the other
three keep printing the old sentence. That is not a small drift; it is the
same product described two ways on two sites at the same time, which is
exactly what the maintainer's "it should look similar on all sites" rules out.

So the loop is: propose the wording, it lands in the SDK, every site picks it
up on its next bump. One sentence, one place, four renderers.

The same applies to the wallet's line with one extra consequence:
`CAT21_WALLET_POSITIONING` IS that line, so spicing it also changes the
wallet's own positioning copy. A spec pins the two identical on purpose.

## 9. The per-site tagline is NOT the SDK's job

The maintainer, verbatim (German), via the cubes session and confirmed to the
SDK as their own instruction:

> die individuelle tagline jedes repos ist NICHT aufgabe des SDK

> alle anderen sessions sollen das selbst formatieren, immer nach dem schema:
> Sometimes Bitcoin is hard money. (newline) Sometimes Bitcoin is ...

`ordpoolFamilyLede` and its tail table are REMOVED from the SDK (they lived
there for about an hour, between §8 and here). Each site writes and formats its
own lede, in its own repo, two lines:

```
Sometimes Bitcoin is hard money.
Sometimes Bitcoin is <this site's own tail>.
```

### What stays shared, and the line that separates the two

**Shared:** `ORDPOOL_FAMILY_HEADING` and `ORDPOOL_FAMILY`. Every site prints
these about EVERY member, so one copy of them is what keeps four renderings of
the same four products identical. cubes printing cat21's line is cubes
describing someone else, and that is exactly what a shared constant is for.

**Local:** a site's own tagline. It describes only itself, only ever renders on
itself, and naming what a visitor is currently looking at is a judgment its own
repo is better placed to make. Hosting it centrally bought no consistency and
put the SDK between a repo and its own voice.

That is the general rule this round produced, and it is sharper than "share
copy": **share what one surface says about ANOTHER; keep local what a surface
says about ITSELF.** §8's reasoning survives intact under it, because the member
lines are the first kind and the tagline is the second.

### The accepted consequence

"Sometimes Bitcoin is hard money." is now written in three repos and can drift.
That is the maintainer's call, made knowing it, and the schema above is what
holds it together. It is recorded here so nobody re-centralises it later as a
tidy-up and undoes a deliberate decision.

### The removal is a breaking change, on purpose

All three sites are live against `ordpoolFamilyLede`. Their next SDK bump will
fail to compile until they localise the lede, which is the loud failure we want
rather than a silently stale sentence. A spec now fails if any lede helper is
re-added to this module, so the rule is enforced rather than merely written
down.

## 10. Family links open in the SAME TAB

The maintainer, verbatim (German), via the cubes session, confirmed to the SDK
as their own instruction:

> innerhalb der ordpool family verlinken wir NICHT per target="_blank", wir
> linken direkt, damit beim durchklicken nicht super viele tabs aufgehen

> alle sessions führen die änderung durch, danach deploy

No `target="_blank"` on family footer links. A reader walking the family
should not end up with a tab per member.

**`rel="noopener"` becomes moot** on those links and can go with the target.
The workspace rule that every `target="_blank"` carries `rel="noopener"` is
unaffected: it applies where a blank target exists, and here none does.

**The wallet row points at GitHub, not a family site**, so it is the one row
where "within the family" and "the destination" disagree. It goes same-tab
too: the wallet IS a family member, the directive is about walking the family
rather than about destination hosts, and the back button is the answer to
landing somewhere unexpected. Flagged here rather than decided silently, so it
can be reversed for that row alone if anyone disagrees.

**The self-row is unaffected.** It is not a link at all (a `span` or `div`,
per §7's lead), so there is no target to remove.
