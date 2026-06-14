# RESCUE: cat21-wallet pre-cut code

This directory contains code that was built inside the `cat21-wallet`
repo during the `/loop` pass (2026-06-14 morning) and then deleted in
commit `c0f822963` ("refactor: scope cut — wallet does cats + nLockTime
+ MCP, SDK does the rest") because it didn't belong in the wallet.

The wallet's scope was cut to two responsibilities:
  (a) display cats and respect nLockTime=21
  (b) offer an MCP server

Everything else moves to `ordpool-sdk`. This RESCUE folder is the
preservation step before the port — every file is the exact byte
sequence that existed in `cat21-wallet-staging` at commit `c0f822963^`
(parent of the deletion commit).

**Do not import from this folder.** The contents are a reference for
the migration only. Once ports land in the live SDK code under
`src/`, the RESCUE folder can be deleted.

## Source provenance

Every file was extracted via:

```sh
cd /Users/johanneshoppe/Work/ordpool/cat21-wallet-staging
git show c0f822963^:<wallet-path> > <rescue-path>
```

Recovery from the original repo:

```sh
git show c0f822963^:packages/bitcoin/src/transactions/generate-cat21-buy-offer-psbt.ts
```

## File-by-file port assessment

### `bitcoin/transactions/generate-cat21-mint-transaction.ts` + `.spec.ts`

**Action: do NOT port.** The SDK already has `src/cat21-mint/cat21.service.helper.ts`
which is materially better — handles per-wallet sequence (0xfffffffd for
Cat21Wallet, 0xfffffffe for others), per-wallet input scripts (Xverse,
Leather, Unisat, ...), SegWit + Legacy, lockTime=21. The wallet's
version was a simplified single-wallet helper that the SDK supersedes.

Keep in RESCUE only as a sanity reference if the SDK's per-wallet
sequence logic ever needs cross-checking.

### `bitcoin/transactions/generate-cat21-buy-offer-psbt.ts`

**Action: port.** No equivalent exists in the SDK. ord-style buyer-
initiated offer builder. Pattern: input 0 = seller's UTXO referenced
unsigned, input 1+ = buyer-funded with SIGHASH_ALL, output 0 = buyer
receive (cat lands here), output 1 = seller payment.

**Port adjustments:**

- Convert from `BitcoinError` enum-style to SDK error pattern.
- Replace any axios calls — there are none in this file. ✓
- Keep `Uint8Array` everywhere. ✓
- Trim history-style comments ("per Phase 4.1", "per ADR-12") to
  behaviour-only.

**Suggested SDK path:** `src/cat21-offer/cat21-offer.helper.ts → buildBuyOffer()`.

### `bitcoin/transactions/validate-cat21-buy-offer.ts`

**Action: port.** Companion to the buy-offer builder. Seller-side
PSBT validation (postage ≥ 546, price ≥ floor, SIGHASH_ALL on every
input, buyer inputs signed, seller input present).

**Port adjustments:**

- Same pattern as the builder. No HTTP. No state.
- Keep the `bytesToHex` helper inline OR replace with the SDK's
  existing hex utility if present.

**Suggested SDK path:** `src/cat21-offer/cat21-offer.helper.ts → validateBuyOffer()`.

### `services/mint/cat21-broadcast.service.ts` + `.spec.ts`

**Action: port as pure function.** No equivalent exists in the SDK.
Lightweight dispatcher: when tx weight > 400_000 → Slipstream, else
mempool. The mempool callback is passed in by the caller; the
dispatcher just decides.

**Port adjustments:**

- Drop `@injectable()` Inversify class wrapper — pure function instead.
- The constructor-injected `SlipstreamApiClient` becomes a regular
  function parameter.
- Vitest → Jest.

**Suggested SDK path:** `src/cat21-broadcast/cat21-broadcast.helper.ts → decideBroadcastChannel() + broadcastCat21()`.

### `services/infrastructure/api/slipstream/slipstream-api.client.ts`

**Action: port with `axios → fetch` rewrite.** No equivalent in SDK.
Marathon Slipstream submission for oversize/non-standard txs.

**Port adjustments:**

- `axios.post → fetch + AbortController`. SDK hard rule.
- Drop `@injectable()` — pure function `submitToSlipstream(rawHex, opts)`.
- Keep the Zod-equivalent response shape check; SDK convention may
  prefer manual property checks over a Zod dependency. Check what the
  existing SDK clients do.

**Suggested SDK path:** `src/cat21-broadcast/slipstream.helper.ts`.

### `services/agent-mode/agent-policy.service.ts` + `.types.ts` + `.spec.ts`

**Action: port as pure function.** No equivalent in SDK. Pure-functional
policy gate for autonomous agent actions: per-action cap, daily cap,
fee-rate ceiling, floor price (sell), counterparty allowlist.

**Port adjustments:**

- Drop `@injectable()` — function `evaluateAgentPolicy(policy, action)`.
- Spec from Vitest → Jest (mechanical).
- Types file can stay similarly named.

**Suggested SDK path:** `src/agent-mode/agent-policy.helper.ts +
agent-policy.types.ts`.

### `extension/pages/cat21-mint/cat21-mint.tsx` + `extension/pages/cat21-offer/cat21-offer.tsx`

**Action: do NOT port.** Mint and offer UI live on `cat21.space` /
`ordpool.space` per the wallet scope cut. Kept here purely as a
reference if the cat21.space frontend wants to copy form-layout
patterns — these scaffolds had no submission logic.

## Port order recommended in the wallet's CLAUDE.md discussion

1. **This step** (rescue) ✓
2. Buy-Offer Builder + Validator into `src/cat21-offer/`
3. Slipstream + Broadcast Dispatcher into `src/cat21-broadcast/`
4. Agent-Mode Policy into `src/agent-mode/`
5. Wallet adds a defense-in-depth offer-validate call before the
   signPsbt user prompt (uses the SDK's ported validator).

## What stays in `cat21-wallet` and does NOT come here

These already live in `cat21-wallet` correctly under the new scope and
are NOT in RESCUE:

- Cat21AssetService (display)
- cat21-ord API client (display + UTXO probe)
- UTXO protection logic in `utxos.service.ts`
- nLockTime preservation through RBF (`use-btc-increase-fee.ts`)
- Polite window providers (`packages/provider/`)
- MCP host (`tools/src/mcp-host/`)

## When this folder can be deleted

After all port targets above are live in `src/` AND the wallet's
defense-in-depth validator wire-up is committed, delete this folder in
a single rm commit.
