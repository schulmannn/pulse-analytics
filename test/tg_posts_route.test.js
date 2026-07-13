'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTgRoutes } = require('../server/routes/tg');

function fullHandler({ db, mtprotoFetch, statsTimeout = 60000 }) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post() {},
    delete() {},
  };
  const pass = (_req, _res, next) => next();
  registerTgRoutes({
    app,
    requireAuth: pass,
    resolveChannel: pass,
    db,
    audit: async () => {},
    log: () => {},
    cacheGet: () => null,
    cacheSet: () => {},
    asyncHandler: (handler) => handler,
    tgCrypto: { configured: () => false },
    mediaLimiter: pass,
    fetchWithTimeout: async () => { throw new Error('bot disabled in test'); },
    collectQrChannelsNow: async () => [],
    TG_TOKEN: '',
    TG_CHANNEL: '@test',
    mtprotoClient: {
      MTPROTO_URL: 'http://mtproto.test',
      MTPROTO_TOKEN: 'test-token',
      MTPROTO_TIMEOUT_STATS_MS: statsTimeout,
      MTPROTO_TIMEOUT_HEAVY_MS: 120000,
      mtprotoFetch,
      mtprotoPost: async () => ({}),
      sendMtprotoError: () => {},
    },
  });
  return routes.get('GET /api/tg/full').at(-1);
}

async function invoke(handler, query = { limit: '100' }) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(body) { this.body = body; return this; },
  };
  let nextError = null;
  await handler(
    { query, channel: { id: 7, source: 'central' }, user: { uid: 11 } },
    res,
    (error) => { nextError = error; },
  );
  if (nextError) throw nextError;
  return res;
}

test('/api/tg/full serves archived posts without a live /posts request', async () => {
  const calls = [];
  const archived = [{ id: 42, date: '2026-07-12T10:00:00Z', text: 'archived', views: 900 }];
  const handler = fullHandler({
    db: {
      enabled: true,
      listPostsForActor: async (channelId, actor, limit) => {
        assert.deepEqual([channelId, actor.uid, limit], [7, 11, 100]);
        return archived;
      },
    },
    mtprotoFetch: async (path) => {
      calls.push(path);
      if (path === '/channel') return { members: 1000 };
      if (path === '/views_summary') return { posts_analyzed: 100 };
      throw new Error(`unexpected ${path}`);
    },
  });

  const res = await invoke(handler);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.posts, archived);
  assert.equal(res.body.posts_source, 'db');
  assert.ok(!calls.includes('/posts'), 'archive hit must not wait for Telethon /posts');
  assert.equal(res.body.errors.posts, null);
});

test('/api/tg/full uses the stats timeout for live posts when the archive is empty', async () => {
  const calls = [];
  const statsTimeout = 61000;
  const live = [{ id: 99, date: '2026-07-13T10:00:00Z', text: 'live', views: 1200 }];
  const handler = fullHandler({
    db: { enabled: true, listPostsForActor: async () => [] },
    statsTimeout,
    mtprotoFetch: async (path, params, timeout) => {
      calls.push({ path, params, timeout });
      if (path === '/channel') return { members: 1000 };
      if (path === '/views_summary') return { posts_analyzed: 1 };
      if (path === '/posts') return { posts: live };
      throw new Error(`unexpected ${path}`);
    },
  });

  const res = await invoke(handler, { limit: '30' });

  assert.deepEqual(res.body.posts, live);
  assert.equal(res.body.posts_source, 'live');
  assert.equal(calls.find((call) => call.path === '/posts').timeout, statsTimeout);
});
