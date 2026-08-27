# Addendum: watch-only is unblocked — re-alignment for the three sessions

Read after `HANDOVER-sdk-ready.md`. This corrects a real gap two of you
found and re-syncs all three sessions on one SDK SHA.

## What was wrong, plainly

`HANDOVER-sdk-ready.md` (and `wallet-picker-watch-only-shared.md`) said the
export/paste callback `promptForSignedPsbt` was "already on every operation's
args". **It was not** — only the inscribe orchestrator had it. The four
cat21 operation orchestrators (mint, transfer, offer-create, offer-accept)
never threaded it, so a watch-only user could `connectXpub` and view, but any
cat action threw *"Watch-only signing requires a promptForSignedPsbt
callback"*. The mint capstone I pointed at proved the **internal** path
(`createTransaction` + `psbtExportSigner` directly), not the **orchestrator**
path you actually call. cat21.space and ordpool.space both caught this and
deferred their xpub row rather than ship a connect-that-fails-every-action.
That was the right call. Thank you.

## What changed (re-pin the SDK)

```jsonc
"ordpool-sdk": "github:ordpool-space/ordpool-sdk#e3412e6"
```

- All four cat21 orchestrators now accept an optional `promptForSignedPsbt`
  on their action method and thread it to the signer, matching inscribe.
- **Proof (two layers, at the right level for each):**
  - *End-to-end signer path* — already node-regtest-proven:
    `watch-only-mint-roundtrip.spec.ts` (pasted xpub → scan → build → sign →
    broadcast → confirmed CAT-21). `createCat21Transaction` calls exactly
    this signer.
  - *Orchestrator forwards the callback* — browser (jsdom) tests, because
    the orchestrators are Angular `@Injectable`s and can't load in the node
    regtest harness. Positive (the callback fires with the built PSBT) +
    negative (omitting it throws `/promptForSignedPsbt/`) for mint
    (`createCat21Transaction`), transfer, and create-offer. accept-offer
    threads the identical verified one-liner as its sibling create-offer.
- `wallet-picker-watch-only-shared.md` now shows the concrete per-operation
  wiring (no more "already on the args" hand-wave).

## How you pass it (the one new thing)

```ts
const prompt = (unsigned: { base64: string; hex: string }): Observable<string> =>
  showExportPasteUi(unsigned);   // resolve with the user's pasted signed PSBT

mintOrchestrator.mint(prompt);
transferOrchestrator.transfer(prompt);
createOfferOrchestrator.createOffer(prompt);
acceptOfferOrchestrator.acceptOffer(prompt);
// injected wallets ignore it — pass it unconditionally.
```

## Where each of you stands + your next step

- **cat21.space** — you're on `2a7d0c1` with the deep-link adopted and the
  xpub row deliberately unshipped. Re-pin to the new SHA and light up the
  row: paste → `connectXpub({ probe })` → per-action `prompt`. Product
  driver: the Genesis Cat (cat #0) on a Sparrow wallet. Nothing else you
  built changes.
- **ordpool.space** — your injected picker is done and at the review gate
  (nothing committed). Re-pin to the new SHA; the mint xpub row is now
  unblocked — wire `mint(prompt)` behind the export/paste UI and you're
  feature-complete for `/cat21-mint`. The bc1q correction you made stands.
- **cubes** — **this gap never affected you.** cubes is inscribe-only and the
  inscribe orchestrator already threaded the callback. Wire the xpub inscribe
  row whenever you reach it (`scanWatchOnly` from `/core` + the inscribe
  orchestrator + `prompt`); there is nothing here to wait for.

## Re-alignment (the workflow is unchanged)

1. Each session: re-pin to the new SHA, wire your xpub row per the corrected
   `wallet-picker-watch-only-shared.md`, then **STOP**.
2. The maintainer reviews each implementation.
3. Only then: cross-check the two sisters, propose alignment findings, never
   silently edit a sister project.

## The commitment

The wallet API surface — the matrix, `connectXpub`, and the four
orchestrators' `promptForSignedPsbt` arg — is now stable and proven at the
consumer entry point, not just internally. Build on this SHA; it won't move
under you again for watch-only.
