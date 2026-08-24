# Child-inscribe (parent/child provenance) — wallet support

Handover for the cat21.space / ordpool consumer session. Read this before
wiring the "add to collection" (parent/child inscribe) UI. It records
which wallets can sign a child reveal, the one that cannot, and the
address-mode requirement two of them impose. Everything here is proven by
the regtest wallet-matrix e2e in `e2e/playwright/specs/*-inscribe-child-roundtrip.spec.ts`.

## Why child-inscribe is different from mint / plain-inscribe

An ord parent/child link is set at reveal time, in one transaction. The
child's reveal tx spends **two** inputs:

- **input 0** — the PARENT inscription's UTXO (this is what proves the
  child belongs to the parent's collection). It sits at the user's
  **ordinals (Taproot) address**, so signing it is a Taproot key-path
  spend with the user's ordinals key.
- **input 1** — the ephemeral COMMIT UTXO that carries the child's ord
  envelope. It is a Taproot **script-path** spend of a non-standard
  (envelope-tweaked) output; the SDK signs it with the ephemeral key.

So the wallet must sign a **Taproot input at the ordinals address, inside
a two-input transaction whose sibling input is a non-standard script-path
spend**. That combination is what separates the wallets below. A plain
inscribe never asks the wallet to sign a tx containing the envelope input
(the ephemeral key handles the whole reveal), which is why every wallet
that fails child-inscribe still passes plain inscribe.

## Support matrix (proven on regtest)

| Wallet | Child-inscribe | Requirement |
|---|---|---|
| Cat21 Wallet | yes | none (signs by input position) |
| Leather | yes | none (signs by input position) |
| Xverse | yes | none (modern `signPsbt`) |
| Unisat | yes | **active address type must be Taproot** |
| Wizz | yes | **active address type must be Taproot** |
| OKX | **no** | wallet-side limitation, see below |
| Phantom | unverified | no child-inscribe e2e; do not assume it works |
| Alby | unverified | no child-inscribe e2e; do not assume it works |

"Unverified" means we have no regtest proof either way. Do not present
Phantom / Alby as supported for collections until a roundtrip exists.

## The Taproot-mode requirement (Unisat, Wizz)

Unisat and Wizz sign only with the **active account's** key: each
`toSignInput` must name the active address. The child reveal's input 0 is
at the ordinals **Taproot** address, so the active address type has to be
**Taproot (P2TR)**. If the user's active type is Native SegWit (a common
default), the active address is the segwit one, it does not match the
Taproot parent input, and the wallet rejects the request with
`invalid address in toSignInput`. The reveal never gets signed.

**Consumer guidance:** before offering child-inscribe on Unisat or Wizz,
check the connected address type. If it is not Taproot, block the action
and tell the user to switch their wallet's active address type to Taproot
(P2TR), then reconnect. This is not something the SDK can do for them; the
active type is chosen inside the wallet UI.

This requirement is specific to operations that spend a Taproot ordinals
input (child-inscribe today; transfer/offer follow the same rule). A mint
that funds from the segwit payment address is unaffected.

## The OKX limitation

**OKX cannot sign a child reveal, and the SDK cannot work around it.**
`okxSigner.signChildRevealParentInputs` fails fast with an actionable
error rather than hanging.

Mechanism (proven across four PSBT variants and reverse-engineered against
OKX v4.1.0): OKX's closed `signPsbt` preview renders every input by
matching its scriptPubKey to a wallet address. The reveal's commit input
(input 1) is a script-path spend whose output key is the ordinals key
**tweaked by the envelope tree**, so it is never an OKX address and the
preview hangs with no popup and no error. That input's scriptPubKey cannot
be hidden either: the parent input's Taproot SIGHASH_ALL signature commits
to every input's scriptPubKey (BIP-341), so OKX needs it in the PSBT to
sign the parent at all. No `signPsbt` option reaches past the preview.

The SDK builds a correct reveal — the byte-identical PSBT is signed by
Cat21 Wallet, Leather, Xverse, Unisat, and Wizz. The block is entirely
inside OKX.

**Consumer guidance:** on OKX, do not offer the "add to collection"
(child-inscribe) action, or offer it disabled with a note that OKX does
not support creating collection inscriptions and that mint, transfer, and
offer work normally. If child-inscribe is attempted anyway, the SDK throws
a clear error you can surface directly. OKX is fully supported for mint,
transfer, offer, and plain inscribe.

## What the SDK does

- The child-inscribe orchestrator (`inscribeChildAndBroadcast`) builds the
  commit + the child reveal and drives the wallet's
  `signChildRevealParentInputs`.
- Every wallet except OKX signs input 0 on a bare wallet-facing PSBT; the
  SDK merges that signature onto the full reveal (whose input 1 carries
  the ephemeral witness), finalizes both inputs, and broadcasts.
- OKX's `signChildRevealParentInputs` throws immediately with the message
  above; nothing is broadcast.
