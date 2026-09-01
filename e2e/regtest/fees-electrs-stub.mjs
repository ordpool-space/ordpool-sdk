#!/usr/bin/env node
/**
 * Shared regtest HTTP shim — SDK-owned, consumed by ordpool + cat21-indexer
 * e2e and the local wallet-runner. Consumers run it straight from node_modules
 * (`node node_modules/ordpool-sdk/e2e/regtest/fees-electrs-stub.mjs`); it's
 * plain .mjs, so there's no build or transpile step.
 *
 * Lets a frontend talk to a bare regtest stack (bitcoind + electrs) without
 * spinning up the full ordpool-backend / cat21-indexer just for a handful of
 * endpoints.
 *
 * Three responsibilities:
 *
 *   1. /api/v1/fees/recommended  → static low-fee body.
 *
 *   2. /api/status               → cat21-indexer-shape status (totalCats=0,
 *      /api/cats/numbers/:ipp/:p    lastSyncTime=null, empty cats lists).
 *      /api/cats/:ipp/:p           ordpool's wallet asset scanner hits
 *                                  these on every connect to identify cat
 *                                  sats among the wallet's UTXOs. On
 *                                  regtest there are no cats, so empty
 *                                  responses are correct AND let the
 *                                  scanner finish (vs. hanging on ECONNREFUSED).
 *
 *   3. /api/*                    → reverse-proxy to electrs path-for-path.
 *      Covers /api/address/<addr>/utxo, /api/tx/<txid>, /api/tx (broadcast).
 *
 * Every response carries `cache-control: no-store` so a "no UTXOs yet"
 * empty body from before funding doesn't get replayed from the browser
 * cache after the wallet is funded + page reloaded.
 *
 * Zero npm deps; uses node:http only. Run as:
 *
 *   PORT=8999 ELECTRS_URL=http://localhost:3000 node fees-electrs-stub.mjs
 */
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT ?? 8999);
const ELECTRS_URL = process.env.ELECTRS_URL ?? 'http://localhost:3000';
// Optional. Set in the ordpool workflow because that frontend's
// StateService.recommendedFees$ is fed by mempool's WebSocket
// pipeline, not by the SDK's REST poll. The cat21-indexer workflow
// leaves WS_ENABLED unset — its fee picker reads
// SDK.recommendedFees$ which polls /api/v1/fees/recommended directly,
// so it doesn't need a fake WS at all.
const WS_ENABLED = process.env.WS_ENABLED === '1';

const DEFAULT_FEES = {
  fastestFee: 5,
  halfHourFee: 3,
  hourFee: 1,
  economyFee: 1,
  minimumFee: 1,
};

// Live state — mutable so a test can POST /admin/fees with a "hot
// mempool" preset before opening the page. Both the REST poll AND
// the next WS broadcast read off this object.
let currentFees = { ...DEFAULT_FEES };

const EMPTY_STATUS_BODY = JSON.stringify({
  totalCats: 0,
  lastSyncTime: null,
});

function emptyCatsBody(itemsPerPage, currentPage) {
  return JSON.stringify({
    currentPage: Number(currentPage) || 1,
    itemsPerPage: Number(itemsPerPage) || 12,
    totalCount: 0,
    totalPages: 0,
    data: [],
  });
}

const CORS_BASE = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': '*',
  'cache-control': 'no-store, no-cache, must-revalidate',
  pragma: 'no-cache',
  expires: '0',
};

const electrs = new URL(ELECTRS_URL);

function jsonResponse(res, body) {
  res.writeHead(200, {
    'content-type': 'application/json',
    ...CORS_BASE,
  });
  res.end(body);
}

function proxyToElectrs(req, res) {
  const upstreamPath = req.url.startsWith('/api/')
    ? req.url.slice('/api'.length) // /api/address/.../utxo → /address/.../utxo
    : req.url;
  // Strip browser-side hop-by-hop / cache / origin headers — electrs
  // doesn't need them and `host: localhost:8999` is misleading once the
  // request is forwarded.
  const upstreamHeaders = { ...req.headers };
  for (const h of ['host', 'origin', 'referer', 'cookie', 'if-none-match',
    'if-modified-since', 'cache-control', 'connection']) {
    delete upstreamHeaders[h];
  }
  const upstream = http.request({
    hostname: electrs.hostname,
    port: electrs.port || 80,
    method: req.method,
    path: upstreamPath || '/',
    headers: upstreamHeaders,
  }, (upRes) => {
    const headers = {
      ...upRes.headers,
      ...CORS_BASE, // overrides cache-control etc. coming from electrs
    };
    // Log non-trivial responses so a "stub returned [] when it shouldn't"
    // failure has something to grep for in fees-stub.log.
    if (/\/address\/.*\/utxo/.test(upstreamPath)) {
      // We buffer the whole body to log it, then re-emit it as a fresh
      // discrete `res.end(buffer)`. The upstream framing headers describe
      // the UPSTREAM wire body, not these re-emitted bytes, so drop
      // content-length / transfer-encoding / content-encoding and let Node
      // recompute content-length for the new buffer. A forwarded stale
      // framing header truncates or hangs the UTXO JSON in the browser.
      const bufferedHeaders = { ...headers };
      delete bufferedHeaders['content-length'];
      delete bufferedHeaders['transfer-encoding'];
      delete bufferedHeaders['content-encoding'];
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.concat(chunks);
        console.log(
          `[utxo] ${req.method} ${upstreamPath} → ${upRes.statusCode} ${body.length}B ${body.length < 200 ? body.toString() : '…'}`,
        );
        res.writeHead(upRes.statusCode ?? 502, bufferedHeaders);
        res.end(body);
      });
      upRes.on('error', (err) => {
        // A late upstream error can fire after we've already answered;
        // guard writeHead to avoid ERR_HTTP_HEADERS_SENT.
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { 'content-type': 'text/plain', ...CORS_BASE });
        res.end(`upstream read error: ${err.message}`);
      });
      return;
    }
    // Streaming branch: writeHead fires before the pipe below, so a
    // mid-stream upstream error arrives after headers are sent — tear the
    // socket down instead of a second (throwing) writeHead.
    upRes.on('error', (err) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'content-type': 'text/plain', ...CORS_BASE });
      res.end(`upstream read error: ${err.message}`);
    });
    res.writeHead(upRes.statusCode ?? 502, headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    // If a streamed response already put headers on the wire, we can't
    // send a 502 status — just destroy the socket.
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/plain', ...CORS_BASE });
    res.end(`upstream electrs error: ${err.message}`);
  });
  req.pipe(upstream);
}

const CATS_NUMBERS_RE = /^\/api\/cats\/numbers\/(\d+)\/(\d+)\/?$/;
const CATS_PAGE_RE = /^\/api\/cats\/(\d+)\/(\d+)\/?$/;

const server = http.createServer((req, res) => {
  // Match local routes against the path only — a trailing `?foo` must not
  // push /api/status or /output/... into the electrs proxy. The proxy
  // branch keeps forwarding the full `req.url` so the query reaches electrs.
  const pathname = req.url.split('?')[0];
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': '*',
      ...CORS_BASE,
    });
    res.end();
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain', ...CORS_BASE });
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && pathname === '/api/v1/fees/recommended') {
    jsonResponse(res, JSON.stringify(currentFees));
    return;
  }
  // Admin: swap the active fee preset + re-broadcast to every WS
  // client so the picker reflects the change without a reload.
  //   POST /admin/fees      body: a (partial) RecommendedFees JSON
  //   POST /admin/fees/reset    no body — restores DEFAULT_FEES
  if (req.method === 'POST' && pathname === '/admin/fees') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const incoming = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        currentFees = { ...DEFAULT_FEES, ...incoming };
        broadcastSnapshot();
        console.log(`[admin] fees → ${JSON.stringify(currentFees)}`);
        res.writeHead(204, CORS_BASE);
        res.end();
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain', ...CORS_BASE });
        res.end(`bad json: ${err.message}`);
      }
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/admin/fees/reset') {
    currentFees = { ...DEFAULT_FEES };
    broadcastSnapshot();
    console.log(`[admin] fees → reset to default`);
    res.writeHead(204, CORS_BASE);
    res.end();
    return;
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    jsonResponse(res, EMPTY_STATUS_BODY);
    return;
  }
  // Stub ord's `/output/<txid>:<vout>` endpoint. Used by the bid
  // marketplace regtest test — both the test (Node fetch) and the
  // cat21-indexer backend (ordClient.getCatsAtOutput) query this to
  // read the cats bundle on a UTXO. Returns a fixed `cats: [0]` so
  // the marketplace flow can assert bundle-drift-free bytes without
  // needing a real ord to walk the chain.
  //
  // For real regtest runs we'd want a proper ord instance; this stub
  // lets the marketplace round-trip prove PSBT-byte fidelity + the
  // backend validator + the accept UI without adding an ord container
  // to the CI substrate.
  const outputMatch = req.method === 'GET' && /^\/output\/([0-9a-f]{64}):(\d+)/i.exec(pathname);
  if (outputMatch) {
    jsonResponse(res, JSON.stringify({
      cats: [0],
      inscriptions: [],
      runes: {},
      sat_ranges: [],
      value: 546,
      script_pubkey: '',
    }));
    return;
  }
  const numbersMatch = req.method === 'GET' && CATS_NUMBERS_RE.exec(pathname);
  if (numbersMatch) {
    jsonResponse(res, emptyCatsBody(numbersMatch[1], numbersMatch[2]));
    return;
  }
  const pageMatch = req.method === 'GET' && CATS_PAGE_RE.exec(pathname);
  if (pageMatch) {
    jsonResponse(res, emptyCatsBody(pageMatch[1], pageMatch[2]));
    return;
  }
  // Everything else falls through to electrs.
  proxyToElectrs(req, res);
});

// `broadcastSnapshot` is hoisted into the outer scope but only does
// real work when the WS path is wired up below. Default no-op so the
// admin endpoints can call it unconditionally.
let broadcastSnapshot = () => {};
// Holds the WebSocketServer once created, so clean shutdown can close it
// (it holds the port) before closing the HTTP server. Stays null when
// WS is disabled or its setup failed.
let wss = null;

if (WS_ENABLED) {
  try {
  // ESM resolves bare imports against the script's directory, not cwd,
  // so a plain `import 'ws'` from this file fails even when invoked
  // from frontend/. Resolve the path explicitly against process.cwd()
  // and feed the resulting file:// URL to `import()`. The ordpool
  // workflow runs this stub from `frontend/` where `ws` is a transitive
  // dep of the mempool fork. WS_PACKAGE_DIR lets a caller override the
  // lookup (e.g. when bundling the stub elsewhere).
  const { default: nodePath } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const wsDir = process.env.WS_PACKAGE_DIR
    ?? nodePath.resolve(process.cwd(), 'node_modules/ws');
  const wsEntry = pathToFileURL(nodePath.join(wsDir, 'wrapper.mjs')).href;
  const { WebSocketServer } = await import(wsEntry);
  wss = new WebSocketServer({ server, path: '/api/v1/ws' });
  // Mempool's frontend sends a JSON command to subscribe to channels
  // (`{"action":"want","data":[...]}`). The state-service consumes
  // top-level keys on every incoming server message. We only need to
  // push `fees` once so `recommendedFees$` emits and the cat21-mint
  // empty-state stops gating on `!utxoLoading()`-after-`recommendedFees$`.
  // Anything we don't recognise we silently drop.
  // `buildFrame()` is recomputed every send so a mid-test
  // POST /admin/fees flips the picker tier values on the next
  // broadcast (or the next client's first `init`).
  function buildFrame() {
    const feeRange = [currentFees.minimumFee, currentFees.fastestFee];
    return JSON.stringify({
      fees: currentFees,
      'mempool-blocks': [
        { blockSize: 1_500_000, blockVSize: 750_000, nTx: 1, totalFees: 5_000, medianFee: currentFees.halfHourFee, feeRange },
      ],
      da: {
        progressPercent: 0,
        difficultyChange: 0,
        estimatedRetargetDate: Date.now() + 1209600000,
        remainingBlocks: 2016,
        remainingTime: 1209600000,
        previousRetarget: 0,
        previousTime: Math.floor(Date.now() / 1000),
        nextRetargetHeight: 2016,
        timeAvg: 600,
        adjustedTimeAvg: 600,
        timeOffset: 0,
        expectedBlocks: 0,
      },
      backendInfo: { hostname: 'regtest-stub', version: 'e2e', gitCommit: 'e2e' },
      // The fees-box-clickable component's `isLoading$` is a
      // combineLatest of `isLoadingWebSocket$` and
      // `loadingIndicators$.pipe(startWith({mempool:0}))` — it stays
      // true (and the picker stays in its skeleton-tile state) until
      // `loadingIndicators.mempool` reaches 100. Without this key the
      // fee picker never exits skeleton and a Playwright spec waiting
      // for `.fee-estimation-container .item a` to count 4 times out
      // (observed on run 27482094562).
      loadingIndicators: { mempool: 100 },
    });
  }
  broadcastSnapshot = () => {
    const frame = buildFrame();
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(frame);
    }
  };
  wss.on('connection', (ws) => {
    console.log('[ws] client connected');
    ws.send(buildFrame());
    ws.on('message', (raw) => {
      // mempool's client kicks off `{"action":"init"}` then `want` —
      // re-send the snapshot on every command so any state pivot lands.
      console.log(`[ws] ← ${raw.toString().slice(0, 200)}`);
      ws.send(buildFrame());
    });
    ws.on('close', () => console.log('[ws] client disconnected'));
  });
  } catch (err) {
    // A failing `ws` import (e.g. run from a dir without the transitive
    // dep) must NOT sink the whole stub — the fee/status/proxy paths need
    // no WS. Degrade to the no-op broadcastSnapshot and let the HTTP
    // server still bind. Set WS_PACKAGE_DIR if a real WS is required here.
    wss = null;
    console.error(`[ws] setup failed, continuing without WebSocket: ${err?.stack ?? err}`);
  }
}

server.listen(PORT, () => {
  console.log(`fees-electrs-stub listening on :${PORT} → ${ELECTRS_URL}${WS_ENABLED ? ' (WS enabled)' : ''}`);
});

// Idempotent: a fast double-signal (SIGINT then SIGTERM) must not
// double-close. Close the WS server first — it holds the listening port
// via the shared HTTP server — then close the HTTP server itself.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const closeHttp = () => server.close(() => process.exit(0));
  if (wss) {
    wss.close(closeHttp);
  } else {
    closeHttp();
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
