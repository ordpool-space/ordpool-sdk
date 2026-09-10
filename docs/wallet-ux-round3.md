# Wallet UX round 3 — asset safety (binding)

Status: **OPEN.** Same procedure as round 2: the SDK coordinates, every
session proposes, the SDK decides, everyone implements, everyone
cross-reviews rendered screens, and the round closes when all five agree.

## 1. The maintainer's instruction

> we should flip this to a warning for all one-address wallets. ordpool had
> this in the cat21 minting screen. maybe it's still there. we recommend a
> safe wallet (that seperates the addresses for payments and assets). if you
> use a single address wallet, create a new address and only use products
> from the ordpool Family (cat21.space, ordpool.space, cat21 wallet).
> otherwise you are in risk to accidentally send your valuable cats as miner
> fees
>
> (also for cat21 wallet: here we need a disclaimer, that this is an
> experimental, hot wallet, for frequent trading. we do not recognize other
> assets. only cats)

## 2. What was wrong, and it was the SDK's

The custody caveat named UniSat, because a workspace note named UniSat. The
connectors disagree. `unisatBasicInfoToWalletInfo` and its `wizz`, `okx` and
`binance` siblings each take ONE `address` and assign it to both slots; Alby
assigns the same string to both explicitly.

| wallet | ordinals | payment | |
|---|---|---|---|
| UniSat, Wizz, OKX, Binance, Alby | same | same | **one address** |
| Xverse, Leather, Phantom, Cat21 Wallet, watch-only | distinct | distinct | separated |

**Five of nine.** Warning about one of them reads as a verdict on that
product while leaving users of the other four unwarned. Fixed in `6dfaede`.

## 3. What the SDK now gives you

```ts
usesSingleAddress(wallet)      // ground truth for a CONNECTED wallet
walletCustodyCaveat(type)      // the shared sentence, or null
SINGLE_ADDRESS_CAVEAT          // that sentence, for a heading or a link
WALLET_MATRIX[].singleAddress  // the fact, for before anyone has connected
```

`usesSingleAddress` compares the two addresses actually returned, so it stays
right if a wallet changes its model. Prefer it whenever a wallet is
connected; the matrix flag is for before that.

**ordpool.space already does the right detection** —
`cat21-mint.component.ts` compares `ordinalsAddress === paymentAddress`,
which is why its warning has always covered all five without anyone
noticing. Its doc comment is wrong (it lists OKX as separated) and its
warning is gated behind a small-UTXO heuristic, so it does not always show.

## 4. What the warning has to say

Approved wording is in `SINGLE_ADDRESS_CAVEAT`. Print it; do not rewrite it.

It states the mechanism rather than a verdict, names no third-party wallet
so it cannot rot, and gives BOTH ways out rather than only the expensive
one: use a wallet that separates the two, **or** start a fresh address and
keep it for the tools that check a coin before spending it.

**Where it goes** follows round 2 §7.14: wherever the connected wallet ENDS
UP HOLDING a cat. Mint, and accepting an offer as the buyer. Never a send,
where the cat is leaving.

**What it must not become:** a pre-connect wall. Round 2 §7.2 stands, a
picker row is logo, name, one button. This is an action-time warning.

## 5. cat21-wallet's own disclaimer

Separate from the above, and NOT a single-address problem: Cat21 Wallet
separates its addresses. The disclosure it owes is different.

> experimental, hot wallet, for frequent trading. we do not recognize other
> assets. only cats.

That last clause is the load-bearing one. The wallet protects CATS. A person
holding inscriptions, runes, rare sats or stamps in it has no such
protection, and nothing else on the screen tells them so. Wording is
cat21-wallet's to draft; placement and register follow round 2.

## 6. Proposals

Same format as round 2. Where does this warning live on your surface, what
does it look like when it fires, and what does a person do next?

## 7. The binding decision

(SDK writes this once every proposal is in.)
