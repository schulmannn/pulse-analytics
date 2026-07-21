'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIgRoutes } = require('../server/routes/ig');
const { createMemoryCache } = require('../server/infrastructure/memoryCache');
const {
  IG_THUMB_MAX_SOURCE_BYTES,
  createIgThumbnailToken,
  verifyIgThumbnailToken,
  isAllowedIgCdnUrl,
  resizeIgThumbnail,
} = require('../server/lib/igThumbnail');

const SECRET = 'ig-thumbnail-test-secret';
const SOURCE = 'https://scontent.cdninstagram.com/v/t51.29350-15/cover.jpg?stp=dst-jpg';

function buildHarness({ fetchWithTimeout, resizeThumbnail, igFetch, log = () => {} } = {}) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
  };
  const pass = (_req, _res, next) => next();
  const cache = createMemoryCache({ maxEntries: 50, ttlMs: 60_000 });
  registerIgRoutes({
    app,
    requireAuth: pass,
    mediaLimiter: pass,
    db: { enabled: false },
    log,
    igFetch: igFetch || (async () => ({ data: [] })),
    refreshIgIfNeeded: async (_channelId, token) => token,
    igConfigured: () => false,
    igCrypto: { configured: () => false },
    igMock: {
      igMockProfile: () => ({ mock: true }),
      igMockTags: () => ({ data: [] }),
      igMockInsights: () => ({ data: [] }),
      igMockPosts: () => ({ mock: true, data: [] }),
      igMockBreakdowns: () => ({ data: [] }),
      igMockOnlineFollowers: () => ({ data: [] }),
      igMockStories: () => ({ data: [] }),
    },
    nearestOf: (value, allowed) => allowed.reduce((best, item) =>
      Math.abs(item - value) < Math.abs(best - value) ? item : best),
    cacheGet: cache.get,
    cacheSet: cache.set,
    fetchWithTimeout: fetchWithTimeout || (async () => { throw new Error('network disabled'); }),
    resizeThumbnail: resizeThumbnail || (async (source) => source),
    AUTH_SECRET: SECRET,
  });
  return routes;
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

async function invoke(handler, req = {}) {
  const res = makeResponse();
  let nextError = null;
  await handler({ query: {}, params: {}, user: { uid: 11 }, ...req }, res, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return res;
}

test('IG thumbnail tokens are CDN-scoped, expiring and tamper-evident', () => {
  const now = 1_800_000_000_000;
  assert.equal(isAllowedIgCdnUrl(SOURCE), true);
  assert.equal(isAllowedIgCdnUrl('https://instagram.fcor2-2.fna.fbcdn.net/cover.jpg'), true);
  assert.equal(isAllowedIgCdnUrl('http://scontent.cdninstagram.com/cover.jpg'), false);
  assert.equal(isAllowedIgCdnUrl('https://cdninstagram.com.evil.test/cover.jpg'), false);
  assert.equal(isAllowedIgCdnUrl('https://169.254.169.254/latest/meta-data'), false);

  const token = createIgThumbnailToken(SOURCE, SECRET, { now, ttlMs: 60_000 });
  assert.equal(verifyIgThumbnailToken(token, SECRET, { now: now + 1000 }), SOURCE);
  assert.equal(verifyIgThumbnailToken(`${token}x`, SECRET, { now: now + 1000 }), null);
  assert.equal(verifyIgThumbnailToken(token, 'other-secret', { now: now + 1000 }), null);
  assert.equal(verifyIgThumbnailToken(token, SECRET, { now: now + 60_001 }), null);
});

test('sharp produces an exact 80x80 JPEG from a large source image', async () => {
  const sharp = require('sharp');
  const source = await sharp({
    create: { width: 2400, height: 1600, channels: 3, background: '#4477aa' },
  }).jpeg().toBuffer();
  const output = await resizeIgThumbnail(source);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 80);
  assert.equal(metadata.height, 80);
  assert.ok(output.length < source.length);
});

test('signed IG thumbnail route resizes once, caches bytes and returns immutable JPEG', async () => {
  const input = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
  const output = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xcc]);
  let fetches = 0;
  let resizes = 0;
  const routes = buildHarness({
    fetchWithTimeout: async (url, options) => {
      fetches += 1;
      assert.equal(url, SOURCE);
      assert.equal(options.redirect, 'manual');
      return new Response(input, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
    resizeThumbnail: async (source) => {
      resizes += 1;
      assert.deepEqual(source, input);
      return output;
    },
  });
  const handler = routes.get('GET /api/ig/thumb').at(-1);
  const token = createIgThumbnailToken(SOURCE, SECRET);

  const first = await invoke(handler, { query: { t: token } });
  const second = await invoke(handler, { query: { t: token } });

  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, output);
  assert.equal(first.headers['Content-Type'], 'image/jpeg');
  assert.equal(first.headers['Cache-Control'], 'public, max-age=86400, immutable');
  assert.equal(first.headers['Content-Length'], String(output.length));
  assert.deepEqual(second.body, output);
  assert.equal(fetches, 1);
  assert.equal(resizes, 1);
});

test('concurrent requests for one cover share the same download and resize', async () => {
  let unblockFetch;
  const fetchGate = new Promise((resolve) => { unblockFetch = resolve; });
  let fetches = 0;
  let resizes = 0;
  const output = Buffer.from([0xff, 0xd8, 0x55]);
  const routes = buildHarness({
    fetchWithTimeout: async () => {
      fetches += 1;
      await fetchGate;
      return new Response(Buffer.from([0xff, 0xd8, 0x01]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    },
    resizeThumbnail: async () => { resizes += 1; return output; },
  });
  const handler = routes.get('GET /api/ig/thumb').at(-1);
  const req = { query: { t: createIgThumbnailToken(SOURCE, SECRET) } };
  const first = invoke(handler, req);
  const second = invoke(handler, req);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  unblockFetch();
  const [firstRes, secondRes] = await Promise.all([first, second]);
  assert.deepEqual(firstRes.body, output);
  assert.deepEqual(secondRes.body, output);
  assert.equal(fetches, 1);
  assert.equal(resizes, 1);
});

test('forged token is a quiet 404 and never reaches the network', async () => {
  let fetches = 0;
  const routes = buildHarness({ fetchWithTimeout: async () => { fetches += 1; } });
  const handler = routes.get('GET /api/ig/thumb').at(-1);
  const res = await invoke(handler, { query: { t: 'forged.token' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.ended, true);
  assert.equal(fetches, 0);
});

test('unsafe redirect is never followed and a valid token falls back to its original CDN URL', async () => {
  let fetches = 0;
  const logs = [];
  const routes = buildHarness({
    fetchWithTimeout: async () => {
      fetches += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      });
    },
    log: (...args) => logs.push(args),
  });
  const handler = routes.get('GET /api/ig/thumb').at(-1);
  const token = createIgThumbnailToken(SOURCE, SECRET);
  const res = await invoke(handler, { query: { t: token } });

  assert.equal(fetches, 1, 'the untrusted redirect target is not requested');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, SOURCE);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(logs[0], ['warn', 'ig_thumbnail_proxy_failed', { code: 'ig_thumb_unsafe_url' }]);
});

test('oversized IG cover is rejected before buffering and falls back without leaking its URL to logs', async () => {
  const logs = [];
  const routes = buildHarness({
    fetchWithTimeout: async () => new Response(null, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(IG_THUMB_MAX_SOURCE_BYTES + 1),
      },
    }),
    log: (...args) => logs.push(args),
  });
  const handler = routes.get('GET /api/ig/thumb').at(-1);
  const res = await invoke(handler, { query: { t: createIgThumbnailToken(SOURCE, SECRET) } });
  assert.equal(res.statusCode, 302);
  assert.deepEqual(logs[0], ['warn', 'ig_thumbnail_proxy_failed', { code: 'ig_thumb_too_large' }]);
  assert.equal(JSON.stringify(logs).includes(SOURCE), false);
});

test('/api/ig/posts mints a table-only thumbnail URL without another Graph request', async () => {
  const calls = [];
  const routes = buildHarness({
    igFetch: async (path) => {
      calls.push(path);
      if (path === '/account-1/media') {
        return { data: [{ id: 'post-1', media_type: 'IMAGE', media_url: SOURCE }] };
      }
      if (path === '/post-1/insights') return { data: [] };
      throw new Error(`unexpected Graph path: ${path}`);
    },
  });
  const handler = routes.get('GET /api/ig/posts').at(-1);
  const res = await invoke(handler, {
    query: { limit: '6' },
    ig: { accountId: 'account-1', token: 'secret-token', source: 'channel', channelId: 7 },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['/account-1/media', '/post-1/insights']);
  const proxyUrl = new URL(res.body.data[0].table_thumbnail_url, 'https://atlavue.app');
  assert.equal(proxyUrl.pathname, '/api/ig/thumb');
  assert.equal(verifyIgThumbnailToken(proxyUrl.searchParams.get('t'), SECRET), SOURCE);
  assert.equal(res.body.data[0].media_url, SOURCE, 'detail views retain the original URL');
});
