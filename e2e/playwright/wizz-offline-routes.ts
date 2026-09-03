import { BrowserContext, Route } from '@playwright/test';

/**
 * Make every Wizz popup hermetic: intercept the wallet's fleet of LIVE
 * third-party backends and answer each with the truthful "empty" result.
 *
 * Wizz (a Unisat fork, mainnet-only) will NOT enable the Sign button in
 * its approval popup until it has loaded the account balance AND
 * analysed the PSBT for atomicals/runes. It does that against its own
 * ep.wizz.cash (Atomicals ElectrumX proxy) + ordx.wizz.cash (runes
 * indexer), plus wallet-api.unisat.io and api.rgbpp.io. If ANY of them
 * throws, the popup shows "Failed to load balance" and Sign stays
 * disabled forever. In CI they are flaky, and when Wizz's own backend is
 * down they 503 for everyone. Nothing here is real on regtest (no
 * atomicals, no runes, no rgbpp assets), so the run must depend only on
 * the local regtest stack, never on Wizz's server uptime.
 *
 * Response shapes are reverse-engineered from the Wizz bundle (ui.js)
 * and verified against WizzWallet/elex-proxy `R::ok`; the unisat + rgbpp
 * envelopes are copied verbatim from real 200 responses captured in CI
 * traces. Canonical copy: consumers (e.g. cubes-frontend) import this
 * from `ordpool-sdk/e2e` instead of keeping their own.
 */
export async function installWizzOfflineRoutes(context: BrowserContext): Promise<void> {
  // Wizz mounts a configs.wizz.cash remote-config fetch that hangs in CI.
  await context.route('**/configs.wizz.cash/**', route => route.abort());

  const okJson = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  });

  // ep.wizz.cash — Atomicals ElectrumX proxy. listscripthash feeds the
  // balance panel (needs an object `global` + arrays it can iterate);
  // decode_psbt feeds the PSBT preview. Both: nothing found.
  await context.route('**/ep.wizz.cash/**', (route: Route) => {
    const u = route.request().url();
    return route.fulfill(okJson(
      u.includes('listscripthash')
        // From the Wizz bundle (ui.js): the sign popup's balance is the
        // Atomicals loader `g`, whose result feeds the panel:
        //   height   = response.global.height   → this IS the `B.height` that
        //              gates the Sign button (empty `global` throws on
        //              `.toLocaleString()`), so it MUST be a number;
        //   utxos    = response.utxos           → `y.utxos.sort()` needs an array;
        //   atomicals= response.atomicals       → iterated as array-or-object.
        // The ElectrumX-proxy client unwraps `.response` when `success` is true
        // (`if (e.success) return e.response; throw e`), so this whole object
        // becomes `y`. The "Network not match" guard only fires when
        // `global.atomical_count` is truthy, so 0 skips it; Wizz's network is
        // "mainnet" (regtest PSBTs are signed from the mainnet-side wallet).
        ? { success: true, response: { global: { height: 900000, network: 'mainnet', atomical_count: 0 }, atomicals: {}, utxos: [] } }
        : { success: true, response: {} },
    ));
  });

  // ordx.wizz.cash — Wizz runes indexer. Crucially it uses the ElectrumX-proxy
  // envelope `{ success, response }`, NOT Unisat's `{ code, msg, data }`. The
  // balance loader's runes step (`de`→`fe` in ui.js) does
  // `if (!n.success) throw new Error(n.message)` then reads `response.runes`
  // (array) + `response.outputs` (one entry PER queried outpoint, else
  // `throw "Invalid output"`). A `{ code, msg, data }` body has no `success`,
  // so it would throw and reject the whole balance → "Failed to load balance",
  // which disables the Sign button. The PSBT-decode step instead does
  // `if (m.success) { … }`, so `success:false` cleanly skips it (regtest
  // PSBTs carry no runes).
  await context.route('**/ordx.wizz.cash/**', (route: Route) => {
    if (route.request().url().includes('/runes/outputs')) {
      // POST body is the JSON array of outpoints being queried; hand back one
      // empty rune-map per outpoint so the per-index loop finds every entry.
      let outpoints: unknown[] = [];
      try {
        const body = JSON.parse(route.request().postData() || '[]');
        outpoints = Array.isArray(body) ? body : (body.data || body.outputs || []);
      } catch { /* no/blank body → no outpoints */ }
      return route.fulfill(okJson({ success: true, response: { runes: [], outputs: outpoints.map(() => ({})) } }));
    }
    // runes/decode/psbt + anything else: success:false → the runes-decode block skips.
    return route.fulfill(okJson({ success: false, response: {} }));
  });

  // api.rgbpp.io — RGB++ assets ([]) + balance ({address, xudt}). Empty.
  await context.route('**/api.rgbpp.io/**', (route: Route) => {
    const u = route.request().url();
    return route.fulfill(u.includes('/assets')
      ? okJson([])
      : okJson({ address: '', xudt: [] }));
  });

  // wallet-api.unisat.io — the Unisat wallet API Wizz inherits. The balance
  // aggregates multi-assets + brc20 + inscriptions here; ALL of them flake
  // in CI (observed 503/-1 run-to-run), so intercept the whole host.
  const UNISAT_ZERO_ASSET = {
    totalSatoshis: 0, btcSatoshis: 0, assetSatoshis: 0, inscriptionCount: 0,
    atomicalsCount: 0, brc20Count: 0, brc20Count5Byte: 0, brc20Count6Byte: 0,
    arc20Count: 0, runesCount: 0,
  };
  await context.route('**/wallet-api.unisat.io/**', (route: Route) => {
    const u = route.request().url();
    if (u.includes('/address/multi-assets')) {
      // one zero-asset object per queried address (the array length must match).
      const addrs = (new URL(u).searchParams.get('addresses') || '').split(',').filter(Boolean);
      return route.fulfill(okJson({ code: 0, msg: 'ok', data: addrs.map(() => UNISAT_ZERO_ASSET) }));
    }
    if (u.includes('/default/check-website')) {
      return route.fulfill(okJson({ code: 0, msg: 'ok', data: { isScammer: false, warning: '', allowQuickMultiSign: false } }));
    }
    // tx/decode2 (per-input PSBT decode) has an input-specific shape we can't
    // fabricate; leave it live (it answers reliably and isn't the balance gate).
    if (u.includes('/tx/decode')) return route.continue();
    // brc20 lists, inscriptions, everything else: empty list.
    return route.fulfill(okJson({ code: 0, msg: 'ok', data: { list: [], total: 0 } }));
  });

  // mempool.space — the sign popup's Atomicals loader reads only the address
  // tx history here (listTxs → address/:addr/txs); the block height it needs
  // comes from the ElectrumX `listscripthash.global.height` above, not from
  // mempool. The other three are for Wizz's MAIN wallet-view balance, stubbed
  // too so no live-mempool flake can leak into the run. Every mempool client
  // throws on a non-200 (`if (200 != status) throw`), so any endpoint left
  // live is a flake source.
  await context.route('**/mempool.space/api/blocks/tip/height**', route =>
    route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, body: '900000' }));
  await context.route('**/mempool.space/api/address/*/utxo**', route => route.fulfill(okJson([])));
  await context.route('**/mempool.space/api/address/*/txs**', route => route.fulfill(okJson([])));
  await context.route('**/mempool.space/api/v1/historical-price**', route =>
    route.fulfill(okJson({ prices: [], exchangeRates: {} })));

  // Wizz marketplace aggregator — not needed for signing, 503s in CI.
  await context.route('**/mkt.wizz.cash/**', route => route.abort());
}
