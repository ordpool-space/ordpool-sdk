# Watch-only (xpub) consumer contract — shared

Binding for all three consumer sessions (cat21.space, ordpool.space,
cubes). Resolves the gap the three sessions independently reported: the
matrix lists `xpub` (Watch-only) as a candidate for every operation, but
there was no consumer contract for turning a pasted key into a working
wallet. There is now — this documents it. Read it together with
`wallet-picker-ux-shared.md`.

## What the SDK provides

Three layers, each proven on regtest, composed into one connect call:

| Layer | Symbol | Entry | Proof |
|---|---|---|---|
| Derive | `deriveWatchOnlyAddresses` | `ordpool-sdk` + `/core` | unit (BIP-84/86 vectors) + regtest vs `bitcoin-cli deriveaddresses` |
| Scan / auto-pick | `scanWatchOnly` | `ordpool-sdk` + `/core` | unit (mock probe) + regtest (real electrs) |
| Connect | `WalletService.connectXpub` | `ordpool-sdk` (Angular) | unit (WalletInfo assembly) |
| End-to-end signer path | — | — | node-regtest: pasted xpub → scan → build → sign → broadcast (`watch-only-mint-roundtrip.spec.ts`); `createCat21Transaction` calls this exact signer |
| Orchestrator forwards `promptForSignedPsbt` | — | — | browser (jsdom) positive + negative tests on mint / transfer / create-offer orchestrators (Angular services can't run in the node regtest harness) |

The `signingMode: 'watch-only'` entry means **no key in the browser**: the
SDK derives the identity from the account PUBLIC key, and the user signs
each operation's PSBT in their own wallet via the export/paste bridge —
you pass a `promptForSignedPsbt` callback to each operation's action
method (see "The signing bridge" below).

## The connect flow (Angular consumers: cat21.space, ordpool.space)

```ts
// 1. The user pastes an account extended public key. For a plain
//    xpub/tpub (BIP-44-vs-BIP-86 ambiguous) pass scriptType; a SLIP-132
//    prefix (ypub/zpub/upub/vpub) implies it.
const info = await firstValueFrom(walletService.connectXpub({
  extendedPublicKey: pastedKey,
  scriptType: 'p2tr',            // omit for ypub/zpub/…; required for plain xpub/tpub
  gapLimit: 20,                  // optional (default 20)
  probe: (address) => yourElectrsProbe(address),
}));
// info is a normal WalletInfo on connectedWallet$. Every action then works
// the same as any wallet, EXCEPT you pass a promptForSignedPsbt callback to
// the action method (injected wallets ignore it; a watch-only wallet needs
// it — see "The signing bridge").
```

**You wire `probe`** (the SDK owns derive + rank; the consumer owns I/O):

```ts
async function yourElectrsProbe(address: string): Promise<AddressProbe> {
  const utxos = await fetch(`${electrs}/address/${address}/utxo`).then(r => r.json());
  return {
    funded: utxos.length > 0,
    fundedSats: utxos.reduce((s, u) => s + u.value, 0),
    // Optional: mark a cat-bearing address so ordinals auto-picks it.
    // electrs alone can't tell a cat from a plain UTXO — use the cat
    // index / ordpool-parser. Omit hasCat and ordinals falls back to
    // receive index 0.
    hasCat: await addressHoldsCat(address),
  };
}
```

Auto-pick (single-account Taproot, the OKX model): **ordinals** = the
cat-bearing address (else receive index 0); **payment** = the
highest-funded address (else index 0). A cat can sit at any index — the
Genesis Cat is not necessarily at index 0 — so index-0-only would miss it.

## Non-Angular consumers (cubes uses `/core`)

cubes-frontend imports from `ordpool-sdk/core` and has no `WalletService`.
Compose the two pure layers directly, then feed the result to the inscribe
orchestrator + `promptForSignedPsbt`:

```ts
import { scanWatchOnly } from 'ordpool-sdk/core';
const scan = await scanWatchOnly({ extendedPublicKey, network, scriptType: 'p2tr', probe });
// scan.payment / scan.ordinals carry { address, publicKeyHex } for the build.
```

## The signing bridge (every operation)

The row's action is **not** "Connect" — it is an **export step**. You pass a
`promptForSignedPsbt` callback as the argument to each operation's action
method. The SDK builds the PSBT and invokes your callback with
`{ base64, hex }`; you render "download / copy this PSBT, sign it in your
wallet, paste the signed PSBT back", and resolve the callback with the pasted
signed PSBT. The SDK finalizes + broadcasts (or, for offer-create, returns
the partial-signed artifact). Injected browser wallets ignore the callback,
so you can pass it unconditionally.

The callback is on **all four cat21 orchestrators + inscribe** (SDK
`>= f83fe40`):

```ts
const prompt = (unsigned: { base64: string; hex: string }): Observable<string> =>
  showExportPasteUi(unsigned);   // resolve with the user's pasted signed PSBT

mintOrchestrator.mint(prompt);                       // Cat21MintOrchestrator
transferOrchestrator.transfer(prompt);               // Cat21TransferOrchestrator
createOfferOrchestrator.createOffer(prompt);         // Cat21CreateOfferOrchestrator
acceptOfferOrchestrator.acceptOffer(prompt);         // Cat21AcceptOfferOrchestrator
cat21Service.createCat21Transaction(…, prompt);      // the low-level mint entry
```

Same bridge the regtest specs drive with `bitcoin-cli walletprocesspsbt`
standing in for Sparrow / Electrum / Coldcard. **Do not omit the callback for
a watch-only wallet** — `psbtExportSigner` throws "Watch-only signing requires
a promptForSignedPsbt callback" without it. The mint orchestrator path is
proven end to end on regtest; transfer/offer thread the identical callback to
their signers, which are themselves regtest-proven to consume it
(`psbt-export-*.spec.ts`).

## UX (extends `wallet-picker-ux-shared.md`)

- **Row action label**: `Connect (xpub)` opening the paste UI, then per
  operation an `Export PSBT` step — never a silent in-page sign.
- **Info popover** (required, per the shared doc): the signing-mode line
  reads "You sign in your own wallet (Sparrow, Electrum, Coldcard, …)".
- **Script-type prompt**: if the pasted key is a plain xpub/tpub, ask the
  user for the account type (Taproot recommended for cats) — the SDK
  throws a clear "script-type-ambiguous" error you surface as that prompt.
- **Scan feedback**: after connect, show which address was auto-picked and
  let the user override (the scan returns the full `scanned` list).

## Scope

Watch-only is v1 for all three sites (maintainer decision). SignMessage is
`Unsupported` for xpub by design (BIP-322 is interactive, no PSBT to
export) — hide the "sign a message" affordance for a watch-only wallet.
