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
