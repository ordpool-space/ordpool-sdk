# ordpool-sdk E2E (regtest)

`docker-compose.regtest.yml` brings up a real Bitcoin regtest backend:
bitcoind + electrs, and (behind a profile) cat21-ord.

```bash
# default: bitcoind + electrs only
docker compose -f e2e/docker-compose.regtest.yml up

# WITH cat21-ord (required for any spec that content-scans a UTXO):
docker compose -f e2e/docker-compose.regtest.yml --profile cat21-ord up
```

The bootstrap polls `:8080/status` (`waitForOrdReady`) before the specs run.

## The content-scan ord wiring (read this before bumping a consumer)

Since the funding safe-layer landed (`FundingRecommendationService` /
`selectFunding` / the `ContentScanPort`), mint + inscribe + transfer +
offer **force-scan every covering funding candidate for content
regardless of size** before auto-picking it. That scan hits an ord's
`/output/<outpoint>`:

- `ordApiUrl/output/<op>` — full-ord content (inscriptions / runes /
  sat_ranges).
- `cat21OrdApiUrl/output/<op>` — cat21-ord (cats).

**In regtest, both must point at a LOCAL ord that resolves regtest
outpoints.** If they point at a production ord (`ord.ordpool.space` /
`ord.cat21.space`), it 404s the unknown regtest outpoint, the scan
classifies `failed`, and the flow refuses to present the coin as
verified-clean. That is the safety feature working, NOT a bug — a coin
whose content could not be verified must never be auto-treated as clean
(the whole point of the unscanned-large-coin footgun fix). Do NOT make
the scan fail-open.

**Reference wiring** — `core-flows-roundtrip.spec.ts` implements the
`ContentScanPort` as:

```ts
const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';
classify: async (outpoint) => {
  const res = await fetch(`${ORD_URL}/output/${outpoint}`,
    { headers: { Accept: 'application/json' } });
  // -> 'clean' | 'has-assets'
}
```

`:8080` is the cat21-ord service (`--regtest --index-cat21 --index-sats
--index-addresses`). It resolves any regtest outpoint on `/output`
(value + sat_ranges + address + cat info), so a fresh funding UTXO
classifies `clean`.

### For an Angular consumer (ordpool / cat21-indexer / cubes)

The Angular `UtxoContentScanner` reads `cat21Config.ordApiUrl` +
`cat21OrdApiUrl`. To make a mint/inscribe regtest pass after bumping to
the safe-layer SDK:

1. Run a local cat21-ord in the regtest stack (the profile above, or
   your own service) and confirm it is synced to the regtest chain.
2. Point BOTH `ordApiUrl` AND `cat21OrdApiUrl` at it (e.g. `sed` both
   `ord.ordpool.space` and `ord.cat21.space` to the local host:port in
   the workflow — the `api.ordpool.space → localhost` sed alone is not
   enough; the ord URLs are separate).

**Caveat — happy path vs asset-detection.** cat21-ord (`--index-cat21`)
does not index real inscriptions/runes, so pointing `ordApiUrl` at it
returns `clean` for a fresh UTXO (correct for the mint happy path) but
will not DETECT a real inscription/rune on a regtest UTXO. To test the
asset-detection path (funding UTXO carrying an inscription →
`has-assets` → `expert-required`), point `ordApiUrl` at a full stock ord
(no `--index-cat21`) — the compose defines a second stock-ord service
for the inscribe-parity specs.
