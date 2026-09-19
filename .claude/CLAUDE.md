# CLAUDE.md

`ordpool-sdk` is the domain library for the ordpool family: one layer above
[`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser), which
extracts artifacts from raw transactions. The SDK does what needs a network or
holds side-effecting logic: PSBT builders, the offer validator, the funding
policy, REST wrappers, per-wallet signers.

MIT, framework-agnostic (RxJS backs the stateful clients' reactivity; RxJS is
not a framework), Node and browser. No npm publish: consumers pin a git sha.
Family-wide rules live in [`/Work/ordpool/CLAUDE.md`](../../CLAUDE.md); this
file is what is local to the SDK.

## Entry points

| Entry point | Barrel | Output | For |
|---|---|---|---|
| `ordpool-sdk` | `src/index.ts` | `dist/index.js` + `dist/index.d.ts` | cat21.space, cubes, ordpool frontends |
| `ordpool-sdk/core` | `src/core.ts` | `dist/core.js` + `dist/core.d.ts` | cat21-wallet |
| `/cat21-validation`, `/cat21-session`, `/network` | per-domain barrels | `dist/**` ESM + `dist-cjs/**` behind `require` | cat21-indexer's backend, any server |

One build (`tsconfig.lib.json`, `src/**/*.ts`); the barrels alone decide what each entry exposes, so a compiled file that is not re-exported is unreachable there.

```ts
import { Cat21Service, buildCat21TransferPsbt } from 'ordpool-sdk';   // bundler
import { buildCat21TransferPsbt } from 'ordpool-sdk/core';            // cat21-wallet
```

The stateful, `Observable`-returning classes (`WalletService`, `Cat21Service`,
`Cat21ApiService`, `UtxoContentScanner`) take plain config types in the
constructor (`Cat21SdkConfig`, `StorageLike`, `Network`), no DI container, and
live at the MAIN entry only. `/core` is the same set minus those; the wallet
composes the pure helpers plus the `executeMint` / `executeTransfer` functional
flows.

## RULE: `/core` is not a server entry

- `/core` reaches the wallet connectors, so it drags `sats-connect`, axios, base58-js, bowser, roughly 955 kB bundled. `sats-connect` is a PEER dep, so a backend that never installs it fails to RESOLVE, and the error names sats-connect rather than the mistake.
- Server-facing code takes `/cat21-validation`, `/cat21-session` or `/network`. Those carry no connector graph (a spec walks the BUILT graph and reds if one creeps in) and ship a CommonJS emit behind their `require` condition, because a jest CJS runtime with `node_modules` untransformed cannot load ESM even where Node can.
- Never widen those barrels with anything reaching `src/wallet/`'s connectors. `verifyBip322Signature` lives under `src/wallet/` and is fine: it imports only `@scure` and `@noble`.

## RULE: ESM, and every relative specifier carries an explicit `.js`

- tsc does not rewrite specifiers, so an extensionless `./foo` stays `./foo` in the emit and Node rejects it. A new import without the extension breaks Node resolution while every test still passes.
- A CommonJS consumer is fine and this trap must not be re-derived: Node 22.12+ requires ESM with no top-level await, this package has none, `cat21-indexer`'s backend declares `node >= 24`. Verified by requiring `/core` and `/inscribe-fee` from a package with no `type` field.
- A whole-package CommonJS build was measured and reverted: cat21.space 1.38 MB to 1.91 MB, cubes 1.46 to 1.86, and ordpool's production build hard-failed its budget. ESM returns all three.

## RULE: `signingMap` is banned, every Bitcoin operation ships as a typed triple

<!-- long-rule: the three layers and the four signer methods are the interface, not an illustration -->

1. **Builder** (internal): a pure function producing the PSBT bytes and owning the input layout. `cat21-{mint,transfer,offer}/*.helper.ts`, `inscribe/inscription-commit.helper.ts`.
2. **Signer method** (internal, on every `WalletSigner`): operation-named, HARDCODED topology. No `signingMap: ReadonlyArray<PsbtSigningTarget>`, no `sigHash` override; topology is the method name.
   - `signSingleFundingInput`: 1 input at paymentAddress, SIGHASH_ALL (mint, inscribe-commit, future RBF / CPFP).
   - `signTransfer`: input 0 = ordinalsAddress, 1..N = paymentAddress, all SIGHASH_ALL. The caller states `fundingInputCount`; positions are derived.
   - `signOfferAccept`: input 0 = ordinalsAddress, nothing else touched. Buyer inputs come pre-signed.
   - `signOfferCreatePsbt`: inputs 1..N = paymentAddress, returns partial-sig bytes, no broadcast.
3. **Orchestrator** (PUBLIC): the only Bitcoin-operation surface a consumer sees. `Cat21Service.createCat21Transaction`, `Cat21TransferOrchestrator.transfer`, `Cat21CreateOfferOrchestrator.createOffer`, `Cat21AcceptOfferOrchestrator.acceptOffer`, `inscribeAndBroadcast`.

`WalletSigner` and the per-method arg types (`SignSingleFundingInputArgs`,
`SignTransferArgs`, `SignOfferAcceptArgs`, `SignOfferCreatePsbtArgs`) are NOT
exported through `core.ts` or `index.ts`; the `exports` map blocks the deep
import. `signAndBroadcast` / `signMultiInputAndBroadcast` / `signPsbtOnly`
remain on each signer for `operationNamedDefaults` delegation and are
unreachable for the same reason. Adding an operation
means builder, sibling signer method, orchestrator, then per-signer specs
pinning the wire-tx bytes plus an orchestrator spec for build to broadcast.

Why: a caller could pass an array missing an input index, the wallet signed what was listed, auto-finalizing wallets emitted a partially-finalized PSBT, and broadcast failed at electrs with `mandatory-script-verify-flag-failed` AFTER the user clicked Sign.

## RULE: A cat UTXO's size is set once at mint and preserved afterwards

<!-- long-rule: one row per operation, and each row is a different money path -->

| Operation | Output 0 | Fee from | Change |
|---|---|---|---|
| Mint | `CAT21_POSTAGE_SATS` = 546, a fresh cat we create | the funding input | `funding - 546 - fee`, dust-absorb |
| Transfer | `catUtxo.value`, the WHOLE incoming UTXO | separate funding inputs, never the cat | `funding - fee`, dust-absorb |
| Offer | `sellerInput.value`, the WHOLE seller UTXO (ord parity) | buyer funding | `buyerFunding - (price + V + fee)`, dust-absorb. Output 1 = `price + sellerInput.value` |

- 546 is a conservative cross-address dust floor (taproot 330, segwit 294, p2sh 540). An external tx can mint a cat at any size.
- Dust-absorb everywhere: change at or above its address's dust floor comes back, sub-dust change becomes a miner tip, tracked as `finalFeeSats`.
- The accept-side validator nets `output1 - sellerInputValue` and enforces only the price floor. It does NOT pin output 0 to 546: stock ord sets it to the inscription's real postage (`cat21-ord/tests/wallet/offer/create.rs` inscribes 9000 sats and asserts `output[0].value == 9000`), so pinning 546 rejects every valid ord-built offer.
- 546 is never a DETECTION rule. Cat membership comes from the cat index (cat21-ord `/address` gives `cat_numbers`, via `catsAtAddress` / `addressHoldsCat`), spendability from `classifyOutpoint` / `makeWatchOnlyProbe`, never from a size heuristic. `CAT21_POSTAGE_SATS` (`src/cat21-protocol/cat21-postage.ts`) is used only by the mint and as a dust-floor fallback.
- FIFO is load-bearing: the cat must be at input 0 and output 0 must be its landing output, or it lands elsewhere silently. The builders enforce both.

Code: `cat21-mint/cat21-mint.helper.ts`, `cat21-transfer/cat21-transfer.helper.ts`, `cat21-offer/cat21-offer.helper.ts`. Proven at 546/3000/9000/30000 in `e2e/regtest/offer-ord-parity-sizes.spec.ts`.

## RULE: Transfer preserves by default, GROW and SHRINK are opt-ins

- `buildCat21TransferPsbt` takes an optional `targetPostageSats`. Omitted means preserve. Set means output 0 = target: GROW above, SHRINK below. Conservation: `change = catUtxo.value + funding - catOutputSats - fee`.
- A set target must clear the recipient's dust floor (the builder throws). PRESERVE is exempt, so a sub-dust cat can be preserved for a later grow.
- GROW rescues a sub-dust cat mined out-of-band (direct-to-miner, bypassing relay's dust rule) and lets a cold wallet self-provision. Bitcoin has no dust rule on INPUTS, only on relayed outputs.
- SHRINK self-funds the fee from the cat's own surplus, so funding may be empty when `catUtxo.value - target >= fee`. Structural parity with `ord wallet send --postage`; a byte-compare is a follow-up.
- ord's `wallet send` preserves up to `MAX_POSTAGE` 20,000 and trims larger ones to `TARGET_POSTAGE` 10,000, erroring `NotEnoughCardinalUtxos` on a normal send (`cat21-ord/src/wallet/transaction_builder.rs`, `Target::Postage`, `strip_excess_postage`). We preserve above 20k too, which is stricter.
- Not done: thread `targetPostageSats` through `Cat21TransferOrchestrator` and its coin selection so cat21.space's UI can offer grow/shrink.

## RULE: Adopt ord's coin selection, do not invent one

- `cat21-fee/ord-coin-select.ts` ports ord's `transaction_builder.rs`: `selectCardinalUtxo` (ord's `select_cardinal_utxo`, best-fit, verified against all six `select_cardinal_utxo_prefer_under` vectors), `estimateTaprootVbytes` / `estimateFeeSats`, `selectOrdParityFunding` (ord's `build_transaction` pipeline, verified against `build_transaction_with_custom_postage`).
- Transfer and create-offer auto-pick the SMALLEST covering UTXO. `pickLargestFundingUtxoThatCovers` is an opt-in preserve-largest-balance strategy.
- Fee estimation in production stays `computePsbtVsize` (accurate per input type). ord's taproot-only model is for the byte-parity proofs, not a blanket change for non-taproot wallets.
- Byte-parity proven against live ord except `nLockTime=21` and the change address: `e2e/regtest/transfer-ord-parity.spec.ts` (vs `ord wallet send --dry-run --postage <target>`, same inputs, sequences, output 0 and the exact change value) and `e2e/regtest/inscribe-ord-parity-roundtrip.spec.ts` (vs `ord wallet inscribe`, plain and metaprotocol, and stock ord blesses our inscription).
- Not applicable: mint has no ord equivalent (`findAutoPickCandidate` selects for content-safety, not value); offer create uses Core's `fundrawtransaction`, so it keeps a structural test.
- Remaining: wire the multi-input `selectOrdParityFunding` for the rare case where no single UTXO covers.

## RULE: CAT-21 mint sequence is per-wallet

| Wallet | Sequence | RBF |
|---|---|---|
| `cat21wallet` | `0xfffffffd` | YES. Our wallet preserves `nLockTime=21` on any replacement (its HARD RULE #1, `CAT21_MINT_INPUT_SEQUENCE`), so a fee bump is safe and useful. |
| everyone else | `0xfffffffe` | NO. A third-party "accelerate" UI would rebuild without `nLockTime=21` and burn the cat. |

- Anchored at PSBT-build time, not signer time: the sequence is part of the bytes the wallet signs over.
- `21` is data, not a time-lock. Block 21 was mined in 2009, so `0xfffffffe` and `0xffffffff` mint identically. We pin `0xfffffffe` because it is the only non-RBF value that is behaviourally well-formed.
- The real protection is RBF signaling: an acceleration UI fires only on sequence at or below `0xfffffffd`.
- Enforced in exactly one place: `src/cat21-protocol/cat21-sequence.ts` `resolveCat21MintInputSequence()`, called from `buildCat21MintPsbt`. Never duplicate the branch. `cat21-sequence.spec.ts` pins the values.
- See also `cat21-wallet/CLAUDE.md` HARD RULE #1 (the wallet half of the contract) and `INTEGRATION-ORDPOOL-SDK.md` in that repo (provider discovery).

## RULE: Never derive a payment address from an on-chain lookup

- A seller's PAYMENT address is knowable only from their own wallet. Never from an ownership lookup, an ord `/output/*`, an electrs `/address/*/utxo`, or any chain source: those return the ORDINALS address.
- Ask permalink: the seller's device reads `wallet.paymentAddress` and puts it in `payTo=`. The buyer's device parses `sellerPaymentAddress` via `parseBuyOfferQueryParams`; missing means an EMPTY field with a prompt, never an auto-fill.
- Transfer recipients are user-supplied. Buyer receive address is `wallet.ordinalsAddress` (cats land at ordinals). Seller change is `wallet.paymentAddress`.
- If you write `setSellerPaymentAddress(ord.address)` or `payTo: catOwner`, trace where the value came from. Brand the types (`OrdinalsAddress` vs `PaymentAddress`) and the compiler catches the miscast.

Why: the offer's payment output lands at the wrong address, the seller's validator returns `payment-output-wrong-address`, the Sign button never enables, and the trade fails silently. Where the two addresses coincide it contaminates the seller's ordinal-safety accounting instead.
Ref: `src/cat21-share/permalink.helper.ts` carries the correct flow.

## RULE: Offers are public, share them anywhere

- Bare base64 of the unsigned-by-buyer PSBT. Query param, fragment, textarea, QR, gist, IPFS: equivalent.
- Consumers MAY add discovery aids. They MUST NOT design around a leak threat model, and MUST NOT frame a channel choice as "for privacy".
- Sniping-proofness is structural: once the seller's signature lands, SIGHASH_ALL commits every byte (`buildCat21BuyOfferPsbt`). No partial-PSBT splicing.

Why: the offer encodes only what lands on-chain when it is accepted, and accepting it costs the taker their own UTXOs at the seller's price.

## RULE: Ship every signer we have code for

- `walletSigners` (`src/wallet/signers/index.ts`) contains every signer file in the directory. No second gate on top of detect-by-signature.
- Detect-by-signature already gates visibility: no `window.<wallet>`, no picker entry, no call. Withholding a signer prevents user feedback, not bugs.
- Phantom ships even though the v26.x desktop binary keeps btc.js dormant (mobile in-app browser has `window.phantom.bitcoin`). Alby ships even without an Alby Hub in CI.
- Pipeline B gaps are known-caveats in the signer's docstring, never registry exclusions.

Ref: `/Work/ordpool/WALLETS.md` holds the definitions, iteration ladder and bootstrap procedure. Read it before starting a new wallet.

## RULE: CI is the test, no manual smoke

- The maintainer will not install wallets and fund them with real BTC per release. CI runs the whole flow against regtest (`e2e/docker-compose.regtest.yml`: bitcoind + electrs, headed Chromium with the real `.crx` under xvfb).
- CI is a verification tool, not a release gate. Pipeline B evidence shapes documentation and skip-comments; it does not decide what ships in the public API.

## RULE: Rebuild and commit `dist-e2e/` when its source changes

- `dist/` is gitignored and built by the `prepare` hook from the pinned sha at consumer-install time. A normal source change has no build step: edit `src/`, `npm test`, commit, push to `main`.
- `dist-e2e/` IS committed, because its barrel imports the Playwright onboarding helpers and `@playwright/test` is an OPTIONAL peer dep, so a prepare-time build would fail for consumers without Playwright. Change anything the `/e2e` barrel emits, run `npm run build:e2e`, commit the regenerated output in the SAME commit. CI runs the build plus `git diff --exit-code dist-e2e/`.
- Shipping to a consumer: bump the sha, run `npm install --package-lock-only ordpool-sdk@github:ordpool-space/ordpool-sdk#<sha>`, commit `package.json` and `package-lock.json` together. CI caches by lockfile hash, so a stale lockfile masks the bump.

## RULE: There is NO staleness guard for a linked consumer

- cat21-wallet imports the COMPILED bytes. Editing SDK source without rebuilding makes a linked wallet run stale bytes, silently, and nothing catches it.
- A sha-pinned consumer cannot hit this (`prepare` builds from that sha). It bites `npm link` development. The whole mitigation is `npm run build:main` between iterations.
- Do not write a guard into this file that does not exist. This section once described `apps/extension/scripts/check-sdk-fresh.cjs` and a `pnpm sdk:watch`; neither has ever existed. A doc inventing a safety net is worse than one admitting the gap.

## RULE: A spec never asserts against the constant the code under test builds from

- `CAT21_POSTAGE_SATS` stays a hardcoded `546` in assertions. The SDK builds that output from its own constant, so importing it compares the value against itself and a postage change leaves the specs green.
- A value the spec merely USES (a path, a URL, a fixture input) should be one imported constant: `TEST_MNEMONIC` / `TEST_PASSWORD` (`e2e/playwright/wallet-test-vectors.ts`), `RESULTS_DIR` (must equal `outputDir` in `playwright.config.ts`), `HARNESS_URL`, and `EXT_PATH` via a `requireUnpackedExtension(wallet)` helper.
- A shared constant owned by a TEST module is not the thing this forbids; the helper is not the code under test.
- The Leather-family password split is deliberate: leather and cat21wallet need the strong one for a zxcvbn meter.

Why: a value the spec asserts must not come from the code under test, or both sides move together and the assertion cannot fail.

## RULE: Keep useful comments

- JSDoc and "why" inline comments stay. Trim the text inside (no bombast, no before-after history); never delete the block.
- Wallet quirks, coin-selection rationale and signing-flow edge cases are exactly what a future reader cannot reconstruct from code.
- Full decision tree in the HQ rule "Keep JSDoc and 'why' comments in every cleanup pass".

## Where code belongs

| Where | Pattern |
|---|---|
| `ordpool-parser` | pure, zero runtime deps, no I/O. Could run unchanged in a Cloudflare Worker |
| `ordpool-sdk` | domain code with a sane dependency footprint, or networked / stateful logic |
| `ordpool/frontend`, `ordpool/backend` | anything importing a frontend framework, mempool framework or upstream internals |

The SDK declares `ordpool-parser` as a runtime dependency via the same `github:`
shorthand the org uses. Never copy parser code into the SDK.

## Conventions

- TypeScript strict, no `any`. `Uint8Array`, never Node `Buffer` outside tests. `ArrayBuffer.isView(x)` rather than `instanceof` for binary type guards. `TextEncoder` / `TextDecoder`. `fetch` + `AbortController`, never axios.
- Pure functions preferred; compose side effects at the entry point.
- `src/index.ts` is the single export point for the main entry. Anything not re-exported is internal.
- Tests: jest in `node` and `jsdom`, real mainnet responses over synthetic fixtures, exact assertions (`toBe(9925)`, not `toBeGreaterThan(0)`).
- Two wallet pipelines: A pins OUR adapter against a mocked wallet API (`src/wallet/signers/*.signer.ts`, `*.signer.angular.spec.ts`, `src/wallet/connectors/`, runs in `npm test`); B pins the REAL wallet's contract using the published `.crx` headed under xvfb (`e2e/playwright/specs/<wallet>-*.spec.ts`, CI only, never on a dev machine). Playwright rules: `~/Work/ordpool/E2E_BEST_PRACTICES.md`.

## Commands

```bash
npm test                # node + browser suites
npm run test:node
npm run test:browser
npm run build           # dist/ + dist-e2e/
npm run build:main      # dist/ only (what the prepare hook runs)
npm run build:e2e       # dist-e2e/ only
npm run clean
npm run create-link     # build + npm link, for local dev consumers
```
