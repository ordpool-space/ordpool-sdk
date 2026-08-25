# Child-inscribe (parent/child provenance) — wallet support

Handover for the cat21.space / ordpool consumer session. Read this before
wiring the "add to collection" (parent/child inscribe) UI. It records which
wallets can sign a child reveal and the address-mode requirement some of them
impose. Everything here is backed by the regtest wallet-matrix e2e in
`e2e/playwright/specs/*-inscribe-child-roundtrip.spec.ts`.

## Why child-inscribe is different from mint / plain-inscribe

An ord parent/child link is set at reveal time, in one transaction. The
child's reveal tx spends **two** inputs:

- **input 0** — the PARENT inscription's UTXO (this is what proves the child
  belongs to the parent's collection). It sits at the user's **ordinals
  (Taproot) address**, so signing it is a Taproot key-path spend with the
  user's ordinals key.
- **input 1** — the ephemeral COMMIT UTXO that carries the child's ord
  envelope. In the full reveal it is a Taproot script-path spend of a
  non-standard (envelope-tweaked) output; the SDK signs it with the ephemeral
  key, not the wallet.

The wallet never has to understand the ord envelope. The SDK hands it a **bare
wallet-facing PSBT** in which input 1 is stripped to a plain `witnessUtxo` (no
tap-leaf) and asks it to sign **only input 0** (the parent, a Taproot key-path
spend at the ordinals address). The SDK then merges that input-0 signature onto
the full reveal (whose input 1 carries the ephemeral script-path witness),
finalizes both inputs, and broadcasts. So child-inscribe asks the wallet for
the same "sign my Taproot input, leave the foreign one" shape as the offer
flows.

## Support matrix

| Wallet | Child-inscribe | Requirement / note |
|---|---|---|
| Cat21 Wallet | proven | none (signs by input position) |
| Leather | proven | none (signs by input position) |
| Xverse | proven | none (modern `signPsbt`) |
| Unisat | proven | **active address type must be Taproot** |
| Wizz | proven | **active address type must be Taproot** |
| OKX | operation proven, e2e flaky | signs input 0 fine; the OKX extension crashes the browser context ~2/3 in the multi-sign child e2e, so the roundtrip is fixmed while the operation stays proven (see below) |
| Alby | not supported | Alby's `signPsbt` signs every input with one Taproot key and has no per-input selection, so it cannot leave the foreign commit input; the SDK's `signChildRevealParentInputs` refuses it up front |
| Phantom | unverified | the desktop build ships `btc.js` dormant (SW has no `btc_*` handlers); no child-inscribe roundtrip exists |

## The Taproot-mode requirement (Unisat, Wizz)

Unisat and Wizz sign only with the **active account's** key: each
`toSignInput` must name the active address. The child reveal's input 0 is at
the ordinals **Taproot** address, so the active address type has to be
**Taproot (P2TR)**. If the user's active type is Native SegWit (a common
default), the active address is the segwit one, it does not match the Taproot
parent input, and the wallet rejects the request with `invalid address in
toSignInput`. The reveal never gets signed.

**Consumer guidance:** before offering child-inscribe on Unisat or Wizz, check
the connected address type. If it is not Taproot, block the action and tell the
user to switch their wallet's active address type to Taproot (P2TR), then
reconnect. This is not something the SDK can do for them; the active type is
chosen inside the wallet UI.

This requirement is specific to operations that spend a Taproot ordinals input
(child-inscribe today; transfer/offer follow the same rule). A mint that funds
from the segwit payment address is unaffected.

## OKX — operation proven, e2e stability caveat

Earlier notes claimed OKX "cannot sign a child reveal". That is wrong. OKX
signs input 0 on the bare wallet-facing PSBT exactly like Unisat/Wizz: it never
sees the envelope script-path because the SDK stripped it, so there is nothing
for its `signPsbt` preview to choke on. The child roundtrip completes with a
valid, parent-linked inscription (verified in CI: the `[child]` logs show both
the commit and the reveal-parent signs completing, and ordpool-parser confirms
the parent tag).

The remaining issue is stability, not capability: the OKX browser extension
tears down the context ("guid not bound" / "context closed") on the order of
two runs in three during the multi-sign child flow (parent-commit,
child-commit, child-reveal), on either sign, non-deterministically. A
reveal-gate plus leftover-page cleanup did not cure it, so the e2e is fixmed
while the operation stays proven.

**Consumer guidance:** OKX child-inscribe works; if you want to be conservative,
surface a note that it may need a retry. Mint, transfer, offer, and plain
inscribe are all cleanly proven on OKX.

## Alby — not supported

Alby's `webbtc.signPsbt` signs **every** input with the account's single
Taproot key and returns a finalized tx, with no per-input selection. It cannot
leave the ephemeral commit input for the SDK, so `signChildRevealParentInputs`
refuses the flow up front rather than corrupting the reveal. This is the same
single-key limit that blocks Alby offers; Alby mint / transfer / plain inscribe
(all inputs Alby-owned Taproot) are proven.

## What the SDK does

- The child-inscribe orchestrator (`inscribeChildAndBroadcast`) builds the
  commit + the child reveal and drives the wallet's
  `signChildRevealParentInputs`.
- Every supported wallet signs input 0 on the bare wallet-facing PSBT; the SDK
  merges that signature onto the full reveal (whose input 1 carries the
  ephemeral witness), finalizes both inputs, and broadcasts.
- Alby is the exception: its `signPsbt` has no per-input selection, so
  `signChildRevealParentInputs` refuses the flow and nothing is broadcast.
