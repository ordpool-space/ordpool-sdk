# ordpool-sdk E2E (regtest)

`docker-compose.regtest.yml` brings up a real Bitcoin regtest backend:
bitcoind + electrs by default, plus three profile-gated services.

| Profile | Service | Host port | What it is |
|---|---|---|---|
| (none) | `bitcoind`, `electrs` | 18443, 3010 | regtest node and our ordpool-electrs (Esplora API) |
| `cat21-ord` | `ord` | 8080 | cat21-ord with `--index-cat21 --index-sats --index-addresses`: answers cats |
| `ord-stock` | `ord-stock` | 8081 | the same binary without `--index-cat21`, with `--index-sats --index-runes --index-addresses`: answers inscriptions, runes and sat ranges |
| `ordpool-backend` | `ordpool-backend` | 8999 | the real ordpool backend (`/content`, `/preview` decoded from bitcoind) |

```bash
# default: bitcoind + electrs only
docker compose -f e2e/docker-compose.regtest.yml up

# both ords (required for any spec that content-scans a UTXO):
docker compose -f e2e/docker-compose.regtest.yml --profile cat21-ord --profile ord-stock up
```

The bootstrap polls `:8080/status` (`waitForOrdReady`) before the specs run;
`waitForOrdSync` and `waitForOrdStockSync` wait for each ord to reach a height.

## The content-scan ord wiring (read this before bumping a consumer)

Mint, inscribe, transfer and offer force-scan every covering funding candidate
for content, regardless of size, before auto-picking it
(`FundingRecommendationService` / `selectFunding` / the `ContentScanPort`). The
scan reads two ord `/output/<outpoint>` answers:

- `ordApiUrl/output/<op>`: the stock ord. `inscriptions`, `runes`, `sat_ranges`.
- `cat21OrdApiUrl/output/<op>`: cat21-ord. `cats`.

`classifyUtxoContent` (`src/cat21-mint/utxo-content.classify.ts`) merges them.
An output is `clean` only when the stock ord answer carries non-empty
`sat_ranges` (proof that ord has indexed it with `--index-sats`) and neither
answer reports an inscription, rune, cat or rare sat. Empty `sat_ranges` with
nothing detected reads as "not indexed" and the scanner returns `scan-failed`;
a 404 or a refused connection reads the same. A coin whose content could not be
verified is never auto-treated as clean. Do NOT make the scan fail-open.

**Reference wiring:** `regtest/core-flows-roundtrip.spec.ts` runs the shipping
`UtxoContentScanner` with `ordApiUrl` on the stock ord (`:8081`) and
`cat21OrdApiUrl` on cat21-ord (`:8080`):

```ts
const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';
const ORD_STOCK_URL = process.env.REGTEST_ORD_STOCK_URL ?? 'http://localhost:8081';
// UtxoContentScanner({ ordApiUrl: ORD_STOCK_URL, cat21OrdApiUrl: ORD_URL, ... })
```

Swapping the two is a silent failure: cat21-ord in `--index-cat21` mode keeps
cats in its inscription index and serves no envelope inscriptions, and it runs
without `--index-runes`, so pointing `ordApiUrl` at it reads inscribed and
rune-carrying coins as carrying nothing.

### For a frontend consumer (ordpool / cat21-indexer / cubes)

The `UtxoContentScanner` reads `cat21Config.ordApiUrl` and `cat21OrdApiUrl`.
Chain and e2e tests fake nothing of ours (`/Work/ordpool/TESTING.md`), so ord
answers come from a real ord synced to the regtest chain:

1. Bring up both ords with the SDK compose profiles above (`cat21-ord` and
   `ord-stock`), and wait for them to sync to the tip before the page scans.
2. Point `ordApiUrl` at the stock ord (`:8081`) and `cat21OrdApiUrl` at
   cat21-ord (`:8080`). Rewrite both ord hosts in the workflow: rewriting
   `api.ordpool.space` alone leaves the ord URLs on their production hosts.
   Confirm the port actually serves `/output`, because a connection refused
   reads to the scanner exactly like a 404 and the coin lands in `scan-failed`.
3. Seed what the spec needs on the chain (`seedInscribedCoin`, `seedRuneCoin`,
   `seedListedCat`, `seedRareSatCoin`, `seedDirtyCoin`). A plain funding coin
   from `fundCommonSats` classifies `clean` against the two real ords.

### `regtest/fees-electrs-stub.mjs` is not an ord

The stub on `:8999` serves fees (`/api/v1/fees/recommended`, `/admin/fees`,
`/admin/fees/reset`, and the mempool WebSocket on `/api/v1/ws` with
`WS_ENABLED=1`), empty cat21-indexer bodies (`/api/status`,
`/api/cats/numbers/:ipp/:p`, `/api/cats/:ipp/:p`), and proxies every other
path to electrs. It also answers `GET /output/<txid>:<vout>`:

- an outpoint registered through `POST /admin/output` answers its registered
  `cats` and `value`;
- every other outpoint answers
  `{cats:[0], inscriptions:[], runes:{}, sat_ranges:[], value:546, script_pubkey:''}`.

The scanner does not read that default as clean. As a cat21-ord answer,
`cats:[0]` reports cat #0 on the outpoint, so the coin is `scanned-with-assets`.
As a stock-ord answer, the empty `sat_ranges` means not indexed, so the coin is
`scan-failed`. Either way the funding coin is not auto-picked. The stub is not a
substitute for ord: wire the scanner to the two real ords as above.
