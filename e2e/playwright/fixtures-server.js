#!/usr/bin/env node
// Tiny static-file server for the Playwright SDK-harness fixtures.
// Playwright's webServer config spawns this before tests; the
// Xverse content-script needs a real HTTP origin (it doesn't
// inject into file:// pages), so we serve over http://localhost.
//
// One file at a time, no recursion outside the fixtures dir, no
// directory listing, no body parsing. ~30 lines, no devDeps.

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, 'fixtures');
const PORT = Number(process.env.HARNESS_PORT || 4500);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

http.createServer((req, res) => {
  const reqPath = (req.url || '/').split('?')[0];
  const file = reqPath === '/' ? '/sdk-harness.html' : reqPath;
  const abs = path.normalize(path.join(ROOT, file));

  // Path-traversal guard.
  if (!abs.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`not found: ${file}`);
      return;
    }
    const ext = path.extname(abs);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`harness fixtures: http://localhost:${PORT}/`);
});
