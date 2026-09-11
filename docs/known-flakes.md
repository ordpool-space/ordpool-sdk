# Known flakes in this repo's own CI

One entry per observed intermittent failure. Each records what was SEEN, not
what was guessed. An entry leaves with a cause and a fix, or it stays open and
honest.

## `watch-only-scan-roundtrip.spec.ts` reads double the funded amount

**Status: OPEN, cause unknown. Not a blocker; no consumer is affected.**

Observed 2026-09-11 on `6b3567d`, lane `E2E (regtest)`, run `34596570213`:

```
● watch-only scan auto-pick vs real electrs (regtest)
  › picks the richest funded index for payment, defaults ordinals to index 0

  expect(res.scanned[5].probe.fundedSats).toBe(500_000)
  Expected: 500000
  Received: 1000000
```

**Why it is a flake and not that commit's doing.** `6b3567d` added one file of
connect-button strings plus two export lines, touching nothing in watch-only
scanning. The identical code passed the same lane on `38c4674`, which differs
by a single markdown file. Same code, same lane, opposite result.

### What is actually known

- The received value is EXACTLY twice the funded amount, which is a poor fit
  for a timing or sync problem and a good fit for the address holding two
  outputs.
- The spec derives a fresh random account key in `beforeAll`, so the addresses
  cannot collide with another run or another spec.
- There is no `jest.retryTimes` anywhere in this repo, so a silent retry
  re-running the funding is ruled out.
- `waitForUtxoAt(addr, 500_000)` waits for ONE utxo whose `value === 500_000`.
  `fundedSats` is a sum over the address's utxos. **So the wait can be
  satisfied while the address holds a second output**, and the guard cannot
  see the condition that fails the assertion one line later.

That last point is the only firm structural finding: the wait and the
assertion measure different things, so the wait is not a guard for the
assertion even in principle.

### What is NOT known

Why the address received a second output at all. `fundFromE2e` is called once
per address in that test. Candidate mechanisms exist and none has been
reproduced, so none is recorded here as the cause.

### How to pick it up

Reproduce first; do not "fix" the assertion. Loop the regtest lane until it
fails, then dump every utxo at `receive[5]` with its txid and vout. Two
outputs from one txid and two outputs from two txids point at different
mechanisms, and that single observation probably settles it.

Tightening `waitForUtxoAt` into a sum-based wait would make the symptom
disappear without explaining it, which would convert a visible flake into an
invisible one. Do that only after the cause is known.
