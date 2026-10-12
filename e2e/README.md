# ordpool-sdk E2E (regtest)

`docker-compose.regtest.yml` brings up a real Bitcoin regtest backend:
bitcoind + electrs by default, plus three profile-gated services. Every stack
runs in a machine-wide slot (below), which decides its host ports; the table
gives slot 0's.

| Profile | Service | Host port, slot 0 | What it is |
|---|---|---|---|
| (none) | `bitcoind`, `electrs` | 18443, 3010 | regtest node and our ordpool-electrs (Esplora API) |
| `cat21-ord` | `ord` | 8080 | cat21-ord with `--index-cat21 --index-sats --index-addresses`: answers cats |
| `ord-stock` | `ord-stock` | 8081 | the same binary without `--index-cat21`, with `--index-sats --index-runes --index-addresses`: answers inscriptions, runes and sat ranges |
| `ordpool-backend` | `ordpool-backend` | 8999 | the real ordpool backend (`/content`, `/preview` decoded from bitcoind) |

```bash
# a slot, the stack (both ords), the chain specs, the teardown, in one command:
COMPOSE_PROFILES=cat21-ord,ord-stock node scripts/e2e-slots.mjs run -- bash -c '
  BOOT=$(./e2e/regtest-bootstrap.sh)
  export REGTEST_FUNDED_ADDR=$(echo "$BOOT" | jq -r .address) REGTEST_FUNDED_WIF=$(echo "$BOOT" | jq -r .wif)
  npm run test:e2e:regtest'
```

`waitForOrdReady` polls cat21-ord's `/status` before the specs run;
`waitForOrdSync` and `waitForOrdStockSync` wait for each ord to reach a height.

## Slots: at most `ORDPOOL_E2E_MAX_STACKS` stacks per machine

A regtest stack is a handful of containers plus, in a wallet lane, a browser.
Several sessions on one machine (other Claude sessions, a human, a consumer
repo) each starting their own is what saturates the machine, so every stack
takes a slot first, and there are only `ORDPOOL_E2E_MAX_STACKS` of them
(default 1, measured and derived in `stack-slots.ts`, `DEFAULT_MAX_STACKS`).

A slot is a directory `~/.ordpool-e2e/slots/slot-<N>` holding `owner.json`:
owner pid and its start time, prefix, ports. It stays held while its owner runs
OR its compose projects have a running container, so a stack keeps its ports
after the bootstrap that started it exits. A slot that meets neither is stale
and the next acquirer reclaims it (under a lock, so exactly one does).

`ORDPOOL_E2E_MAX_STACKS` caps how many slots are HELD, not which numbers they
get. An acquirer takes the lowest free slot number whose ports nothing serves
yet; a number with a port already in use outside the slots (another project's
MariaDB on 3306, say) is passed over for the next one. With the default of 1
and 3306 taken, a `--kind consumer` stack therefore runs in slot 1 (MariaDB on
3316), and a second request waits until it is torn down. Counting the held
slots and creating the next one happen under one machine-wide lock
(`<slot dir>/.cap-lock`), so racing acquirers never hold more than the cap
between them.

Slot N gives the stack everything it publishes:

| | Slot N | Slot 0 |
|---|---|---|
| host port of a service | base + 10 N (`SLOT_PORT_BASES`, `stack-ports.ts`) | 3010 electrs, 8080 cat21-ord, 8081 ord-stock, 18443 bitcoind, ... |
| `E2E_PREFIX` (compose project, container and image names) | `ordpool-e2e-s<N>` | `ordpool-e2e` |

Up to 30 slots fit before two services would share a port. Container ports are
fixed; only the host side of each mapping moves.

| Variable | Set by | Meaning |
|---|---|---|
| `ORDPOOL_E2E_MAX_STACKS` | you, machine-wide (shell profile) | how many stacks at once; default 1 |
| `ORDPOOL_E2E_SLOT_DIR` | rarely | slot directory, default `~/.ordpool-e2e/slots` |
| `ORDPOOL_E2E_SLOT_WAIT_MS` | rarely | how long to wait in line; default 40 min, the longest lane's job cap |
| `E2E_SLOT`, `E2E_PREFIX` | the slot | slot number and prefix |
| `E2E_BITCOIND_RPC_HOST_PORT`, `E2E_BITCOIND_P2P_HOST_PORT`, `E2E_ZMQ_RAWBLOCK_HOST_PORT`, `E2E_ZMQ_RAWTX_HOST_PORT`, `E2E_ELECTRS_HOST_PORT`, `E2E_ELECTRUM_HOST_PORT`, `E2E_ORD_HOST_PORT`, `E2E_ORD_STOCK_HOST_PORT`, `E2E_ORDPOOL_BACKEND_HOST_PORT`, `E2E_MARIADB_HOST_PORT`, `E2E_REDIS_HOST_PORT` | the slot | the compose files' host ports |
| `E2E_FEES_STUB_PORT`, `E2E_HARNESS_PORT`, `E2E_APP_PORT`, `E2E_APP_BACKEND_PORT` | the slot | ports of what runs beside the stack: the fees stub, the SDK harness page, a consumer's static app server and its own backend |
| `REGTEST_BITCOIND_CONTAINER`, `REGTEST_ORD_CONTAINER`, `REGTEST_ORD_STOCK_CONTAINER` | the slot (`--kind consumer` names the consumer compose's containers) | what the helpers `docker exec` into |

`scripts/e2e-slots.mjs` (`npm run e2e:slots -- <command>`):

```bash
node scripts/e2e-slots.mjs list                        # who holds which slot, how long, why
node scripts/e2e-slots.mjs run [--kind consumer] -- <cmd...>   # slot, command, teardown, release
node scripts/e2e-slots.mjs acquire --owner-pid "$PPID" --format github >> "$GITHUB_ENV"
node scripts/e2e-slots.mjs env --slot N                # print slot N's environment (eval it)
node scripts/e2e-slots.mjs down N                      # tear YOUR stack in slot N down, release it
node scripts/e2e-slots.mjs reclaim                     # drop stale slots
```

Never `down` another session's slot: `list` shows the owner, and a slot whose
owner still runs needs `--force`.

**Waiting in line.** When the cap is reached, or below it every free slot
number has a port in use outside the slots, an acquirer waits: it prints which
of the two it is (`cap reached: 1 of ORDPOOL_E2E_MAX_STACKS=1 slots held`, or
`slot 0: port 3306 in use by a non-slot process`), who holds each slot (prefix,
pid, age, why) at once, whenever that changes and every minute, and gives up
after `ORDPOOL_E2E_SLOT_WAIT_MS` with the holders and these commands. A slot
number passed over on the way to a free one is logged as `skipped slot 0: port
3306 in use by a non-slot process`. Ctrl-C leaves the line at once; nothing is held until the
slot is. This is not a spec wait and not under the 30 s per-wait bound: it runs
before the runner starts, and what it waits for, another lane finishing, takes
minutes by design. Its bound is the job cap of the longest lane (40 min,
`.github/workflows/e2e-playwright.yml`), because a slot held longer than any
lane may run is a stack nobody tore down, and waiting longer cannot help.

**The bootstraps.** `regtest-bootstrap.sh` and `consumer-environment-bootstrap.sh`
source `stack-slot.sh`. With `E2E_SLOT` set (a `run`, a workflow's acquire step)
they use that slot; without it they acquire one for themselves, and the stack
keeps it until `down`. A failing bootstrap that acquired its own slot tears its
stack down and releases it. Both print the slot and its environment (`slot`,
`prefix`, `env`) in their JSON.

**A runner** holds one stack: the SDK workflows acquire with `--owner-pid
"$PPID"` (the runner's worker process, alive for the whole job) and get slot 0,
the ports and container names above.

**A consumer** gets its ports from the slot environment, never from a literal:
`regtestServiceUrls()` (`electrs`, `ord`, `ordStock`, `ordpoolBackend`,
`feesStub`, `harness`, `app`, `appBackend`), `stackPort(service)`,
`stackUrl(service)`, `HARNESS_URL`, all from `ordpool-sdk/e2e`, all read from
the same variables `launchWalletContext` lets through. A workflow step reads
`$E2E_ELECTRS_HOST_PORT` and its siblings. Its app is served on `E2E_APP_PORT`
and its own backend on `E2E_APP_BACKEND_PORT`, so two consumers' lanes in two
slots never meet.

**Without Playwright.** `ordpool-sdk/e2e/stack` serves `stackPort`, `stackUrl`,
`slotEnv` and the rest of `stack-ports.ts`, `e2eTimeoutMs`, and
`regtestWallet()` (the bitcoind wallet the bootstraps create and the helpers
spend from: `REGTEST_WALLET`, default `ordpool-e2e`), and loads nothing of
`@playwright/test`. A backend's jest specs import from there, with no
`moduleNameMapper`; `ordpool-sdk/e2e` re-exports the same bindings.

**The per-wait bound outside a test.** Every SDK helper asserts through
`e2eExpect` (Playwright's `expect` configured with `e2eTimeoutMs()` at each
call), and every SDK launch (`launchWalletContext`, `launchOfflineContext`,
each context `launchOfflineBrowser` opens) sets the context's default action
and navigation timeout to `e2eTimeoutMs()`. The onboarders set the same
defaults on the page or context they are handed. So a helper in a consumer's
globalSetup, where no test exists and Playwright would wait its built-in 5 s
per assertion and 30 s per action, stops at the runner config's bound.

**Files into a container go through a build context, never a bind mount.** A
bind mount resolves its host path inside the Docker VM, and a VM that shares
only some host directories (colima shares `/var/folders`, not `/Users`) mounts
an empty directory for a checkout elsewhere, without an error. The consumer
MariaDB image COPYs `mariadb-init/*.sql` instead, and the bootstrap builds it
before every `up` and waits until users `mempool` and `cat21` log in over TCP.
`stack-ports.unit.spec.ts` fails on a host path in any compose file.

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
`UtxoContentScanner` with `ordApiUrl` on the stock ord and `cat21OrdApiUrl` on
cat21-ord, both from the slot:

```ts
import { ORD_URL, ORD_STOCK_URL } from './regtest-helpers';
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
2. Point `ordApiUrl` at the stock ord (`E2E_ORD_STOCK_HOST_PORT`) and
   `cat21OrdApiUrl` at cat21-ord (`E2E_ORD_HOST_PORT`). Rewrite both ord hosts in the workflow: rewriting
   `api.ordpool.space` alone leaves the ord URLs on their production hosts.
   Confirm the port actually serves `/output`, because a connection refused
   reads to the scanner exactly like a 404 and the coin lands in `scan-failed`.
3. Seed what the spec needs on the chain (`seedInscribedCoin`, `seedRuneCoin`,
   `seedListedCat`, `seedRareSatCoin`, `seedDirtyCoin`). A plain funding coin
   from `fundCommonSats` classifies `clean` against the two real ords.

### `regtest/fees-electrs-stub.mjs` is not an ord

The stub on `E2E_FEES_STUB_PORT` (slot 0: 8998) serves fees (`/api/v1/fees/recommended`, `/admin/fees`,
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
