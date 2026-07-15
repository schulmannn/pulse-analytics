'use strict';

// Static-delivery characterization (Release 1 capacity hardening, part D): content-hashed Vite
// assets get a 1-year immutable cache, the SPA HTML stays revalidatable (never frozen), and
// eligible responses are gzip-compressed. Self-contained (a temp dist + the SAME building blocks
// app.js mounts) so it runs without frontend/dist and doesn't touch the real bundle.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const compression = require('compression');
const { assetCacheControl, IMMUTABLE, REVALIDATE } = require('../server/lib/staticAssets');

// ── Pure policy (dist-independent) ──────────────────────────────────────────────────────────────
test('assetCacheControl: only content-hashed /assets/** are immutable; everything else revalidates', () => {
  assert.equal(assetCacheControl('/app/frontend/dist/assets/index-a1b2c3d4.js'), IMMUTABLE);
  assert.equal(assetCacheControl('C:\\app\\frontend\\dist\\assets\\index-a1b2c3d4.css'), IMMUTABLE);
  assert.equal(assetCacheControl('/app/frontend/dist/assets/vendor.js'), REVALIDATE);
  assert.equal(assetCacheControl('/app/frontend/dist/index.html'), REVALIDATE);
  assert.equal(assetCacheControl('/app/frontend/dist/favicon.svg'), REVALIDATE);
  assert.match(IMMUTABLE, /max-age=31536000/);
  assert.match(IMMUTABLE, /immutable/);
  assert.doesNotMatch(REVALIDATE, /immutable/);
});

// ── Integration over a temp dist ────────────────────────────────────────────────────────────────
let server;
let baseUrl;
let distDir;

test.before(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlavue-dist-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  // A compressible JS payload well above compression's ~1KB threshold.
  const bundle = `// hashed bundle\n${'export const chunk = "atlavue capacity hardening payload";\n'.repeat(200)}`;
  fs.writeFileSync(path.join(distDir, 'assets', 'index-a1b2c3d4.js'), bundle);
  fs.writeFileSync(path.join(distDir, 'index.html'), `<!doctype html><html><head><title>Atlavue</title></head><body>${'x'.repeat(2000)}</body></html>`);

  const app = express();
  app.use(compression());
  // Same static config as app.js: hashed /assets/** immutable, unhashed revalidatable.
  app.use(express.static(distDir, {
    index: false,
    setHeaders: (res, filePath) => { res.setHeader('Cache-Control', assetCacheControl(filePath)); },
  }));
  // SPA fallback (as app.js): sendFile default → `public, max-age=0`, never immutable.
  app.get('*', (req, res) => { res.sendFile(path.join(distDir, 'index.html')); });

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
});

// Raw http (NOT auto-decompressing) so we can observe Content-Encoding directly.
function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${pathname}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('hashed /assets/** are served immutable for a year', async () => {
  const r = await get('/assets/index-a1b2c3d4.js', { 'Accept-Encoding': 'identity' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('compression gzips an eligible (>threshold, compressible) asset response', async () => {
  const r = await get('/assets/index-a1b2c3d4.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
});

test('SPA index.html stays revalidatable (max-age=0, never immutable)', async () => {
  const r = await get('/some/deep/route', { 'Accept-Encoding': 'identity' });
  assert.equal(r.status, 200);
  const cc = r.headers['cache-control'] || '';
  assert.match(cc, /max-age=0/, `index HTML must be max-age=0 (got "${cc}")`);
  assert.doesNotMatch(cc, /immutable/, 'index HTML must never be immutable');
});
