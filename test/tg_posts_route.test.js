'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTgRoutes } = require('../server/routes/tg');

function tgHandlers({
  db,
  mtprotoFetch,
  mtprotoPost = async () => ({}),
  tgCrypto = { configured: () => false },
  collectQrChannelsNow = async () => [],
  collectManagedPostStatsNow,
  statsTimeout = 60000,
  cacheGet = () => null,
  cacheSet = () => {},
  log = () => {},
  fetchWithTimeout = async () => { throw new Error('bot disabled in test'); },
  sendMtprotoError = (res, err) => res.status(err.status || 503).json({
    error: err.message,
    ...(err.retryAfter != null ? { retry_after: err.retryAfter } : {}),
  }),
}) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
    delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); },
  };
  const pass = (_req, _res, next) => next();
  registerTgRoutes({
    app,
    requireAuth: pass,
    resolveChannel: pass,
    db,
    audit: async () => {},
    log,
    cacheGet,
    cacheSet,
    asyncHandler: (handler) => handler,
    tgCrypto,
    mediaLimiter: pass,
    fetchWithTimeout,
    collectQrChannelsNow,
    collectManagedPostStatsNow,
    TG_TOKEN: '',
    TG_CHANNEL: '@test',
    mtprotoClient: {
      MTPROTO_URL: 'http://mtproto.test',
      MTPROTO_TOKEN: 'test-token',
      MTPROTO_TIMEOUT_STATS_MS: statsTimeout,
      MTPROTO_TIMEOUT_HEAVY_MS: 120000,
      mtprotoFetch,
      mtprotoPost,
      sendMtprotoError,
    },
  });
  return routes;
}

async function invokeRoute(handler, req = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
  let nextError = null;
  await handler(
    { query: {}, body: {}, user: { uid: 11 }, ...req },
    res,
    (error) => { nextError = error; },
  );
  if (nextError) throw nextError;
  return res;
}

test('public central thumbnail proxy serves persisted DB media before the revoked legacy session', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb]);
  const calls = [];
  const handler = tgHandlers({
    db: {
      enabled: true,
      getOwnerChannelId: async () => 5,
      getPostMedia: async (channelId, postId, size) => {
        calls.push([channelId, postId, size]);
        return jpeg;
      },
    },
    mtprotoFetch: async () => ({}),
  }).get('GET /api/tg/mtproto/thumb/:id').at(-1);

  const res = await invokeRoute(handler, { params: { id: '1241' }, query: { size: 'lg' } });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, jpeg);
  assert.equal(res.headers['Content-Type'], 'image/jpeg');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=86400');
  assert.deepEqual(calls, [[5, 1241, 'lg']], 'lookup is scoped to the one configured public central channel');
});

test('thumbnail DB miss preserves the legacy live fallback and honest 503 placeholder path', async () => {
  const handler = tgHandlers({
    db: {
      enabled: true,
      getOwnerChannelId: async () => 5,
      getPostMedia: async () => null,
    },
    mtprotoFetch: async () => ({}),
  }).get('GET /api/tg/mtproto/thumb/:id').at(-1);

  // The harness' raw fetchWithTimeout throws, modelling the currently revoked legacy TG_SESSION.
  const res = await invokeRoute(handler, { params: { id: '1241' }, query: {} });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'источник недоступен' });
});

test('public central avatar proxy serves the bounded managed snapshot JPEG DB-first', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
  let liveCalls = 0;
  const handler = tgHandlers({
    db: {
      enabled: true,
      getOwnerChannelId: async () => 5,
      getPublicTgChannelPhoto: async () => jpeg.toString('base64'),
    },
    mtprotoFetch: async () => ({}),
    fetchWithTimeout: async () => { liveCalls++; throw new Error('must not run'); },
  }).get('GET /api/tg/mtproto/channel/photo').at(-1);

  const res = await invokeRoute(handler);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, jpeg);
  assert.equal(res.headers['Content-Type'], 'image/jpeg');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=86400');
  assert.equal(liveCalls, 0);
});

test('invalid managed avatar falls through to the unchanged global photo proxy', async () => {
  const live = Buffer.from([0xff, 0xd8, 0x09, 0x08]);
  const handler = tgHandlers({
    db: {
      enabled: true,
      getOwnerChannelId: async () => 5,
      getPublicTgChannelPhoto: async () => Buffer.from('not-jpeg').toString('base64'),
    },
    mtprotoFetch: async () => ({}),
    fetchWithTimeout: async () => ({
      ok: true,
      buffer: async () => live,
      headers: { get: () => 'image/jpeg' },
    }),
  }).get('GET /api/tg/mtproto/channel/photo').at(-1);

  const res = await invokeRoute(handler);
  assert.deepEqual(res.body, live);
  assert.equal(res.headers['Content-Type'], 'image/jpeg');
});

test('central owner post stats prefer managed session and cache only the returned public payload', async () => {
  const managed = { available: true, views_graph: { x: [1], series: [] }, reactions: [] };
  const calls = [];
  const cached = [];
  const handler = tgHandlers({
    db: { enabled: true, getTgSession: async (uid) => ({ uid, session_enc: 'enc', session_version: '4' }) },
    collectManagedPostStatsNow: async (session, channel, id) => {
      calls.push({ session, channel, id });
      return managed;
    },
    mtprotoFetch: async () => { throw new Error('global path must not run'); },
    cacheSet: (key, value) => cached.push({ key, value }),
  }).get('GET /api/tg/mtproto/post_stats/:id').at(-1);

  const channel = { id: 7, source: 'central', owner_uid: 11, tg_channel_id: 999 };
  const res = await invokeRoute(handler, { params: { id: '42' }, channel, user: { uid: 11 } });
  assert.deepEqual(res.body, managed);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 42);
  assert.deepEqual(cached, [{ key: 'mtproto:poststats:7:42', value: managed }]);
});

test('central non-owner never receives another user managed session and keeps global stats path', async () => {
  let sessionReads = 0;
  let managedCalls = 0;
  const global = { available: true, views_graph: null, reactions: null };
  const handler = tgHandlers({
    db: { enabled: true, getTgSession: async () => { sessionReads++; return { session_enc: 'secret' }; } },
    collectManagedPostStatsNow: async () => { managedCalls++; return {}; },
    mtprotoFetch: async (path) => {
      assert.equal(path, '/post_stats/42');
      return global;
    },
  }).get('GET /api/tg/mtproto/post_stats/:id').at(-1);

  const channel = { id: 7, source: 'central', owner_uid: 99, tg_channel_id: 999 };
  const res = await invokeRoute(handler, { params: { id: '42' }, channel, user: { uid: 11 } });
  assert.deepEqual(res.body, global);
  assert.equal(sessionReads, 0);
  assert.equal(managedCalls, 0);
});

test('managed post-stats failure falls back globally and logs only an allow-listed code', async () => {
  const logs = [];
  const global = { available: false, error: 'not enough data' };
  const handler = tgHandlers({
    db: { enabled: true, getTgSession: async (uid) => ({ uid, session_enc: 'enc', session_version: '4' }) },
    collectManagedPostStatsNow: async () => {
      throw Object.assign(new Error('private upstream detail'), { code: 'raw_account_identifier' });
    },
    mtprotoFetch: async () => global,
    log: (level, event, meta) => logs.push({ level, event, meta }),
  }).get('GET /api/tg/mtproto/post_stats/:id').at(-1);

  const channel = { id: 7, source: 'central', owner_uid: 11, tg_channel_id: 999 };
  const res = await invokeRoute(handler, { params: { id: '42' }, channel, user: { uid: 11 } });
  assert.deepEqual(res.body, global);
  assert.deepEqual(logs, [{
    level: 'warn', event: 'tg_post_stats_managed_fallback',
    meta: { uid: 11, channel_id: 7, code: 'collect_failed' },
  }]);
});

function fullHandler(options) {
  return tgHandlers(options).get('GET /api/tg/full').at(-1);
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

test('successful QR reconnect immediately refreshes existing tracked QR channels', async () => {
  const events = [];
  let releaseRefresh;
  const refreshed = new Promise((resolve) => { releaseRefresh = resolve; });
  const session = { uid: 11, session_enc: 'encrypted:fresh', session_version: '2' };
  const tracked = { id: 7, owner_uid: 11, source: 'qr', tg_channel_id: 777, username: 'tracked' };
  const centralCh = { id: 5, owner_uid: 11, source: 'central', tg_channel_id: 555, username: 'central' };
  const routes = tgHandlers({
    db: {
      enabled: true,
      saveTgSession: async (uid, data) => events.push(['saved', uid, data]),
      getTgSession: async () => session,
      listChannels: async () => [
        centralCh,
        tracked,
        { id: 8, source: 'collector', tg_channel_id: 888 },
        { id: 9, source: 'qr', tg_channel_id: null },
        { id: 10, source: 'central', tg_channel_id: null },
        { id: 11, owner_uid: 99, source: 'qr', tg_channel_id: 111, username: 'shared-qr' },
        { id: 12, owner_uid: 99, source: 'central', tg_channel_id: 222, username: 'shared-central' },
      ],
    },
    mtprotoFetch: async () => ({}),
    mtprotoPost: async (path) => {
      if (path === '/qr/start') return { id: 'login-1', url: 'tg://login', expires_in: 60 };
      if (path === '/qr/poll') {
        return {
          status: 'ok',
          session: 'plaintext:fresh',
          tg_user_id: 42,
          username: 'owner',
          channels: [],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    tgCrypto: {
      configured: () => true,
      encrypt: (value) => `encrypted:${value.split(':').at(-1)}`,
    },
    collectQrChannelsNow: async (savedSession, channels) => {
      events.push(['refreshed', savedSession, channels]);
      releaseRefresh();
    },
  });

  await invokeRoute(routes.get('POST /api/tg/qr/start').at(-1));
  const response = await invokeRoute(routes.get('POST /api/tg/qr/poll').at(-1), {
    body: { id: 'login-1' },
  });
  await refreshed;

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'ok');
  assert.deepEqual(events[0], [
    'saved',
    11,
    { tg_user_id: 42, username: 'owner', session_enc: 'encrypted:fresh' },
  ]);
  // The refresh includes the central channel + the tracked QR channel (both with a tg id), but NOT
  // the collector channel, rows without a tg id, or visible workspace channels owned by somebody
  // else — reconnect may only write channels owned by the session owner.
  assert.deepEqual(events[1], ['refreshed', session, [centralCh, tracked]]);
});
test('/api/tg/qr/start allows a cold Telegram service to start without changing other POSTs', async () => {
  const calls = [];
  const statsTimeout = 61000;
  const routes = tgHandlers({
    db: { enabled: true },
    mtprotoFetch: async () => ({}),
    mtprotoPost: async (path, options) => {
      calls.push({ path, options });
      return { id: 'login-1', url: 'tg://login', expires_in: 60 };
    },
    tgCrypto: { configured: () => true },
    statsTimeout,
  });

  const response = await invokeRoute(routes.get('POST /api/tg/qr/start').at(-1));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{
    path: '/qr/start',
    options: { timeoutMs: statsTimeout, retryConnectionErrors: true },
  }]);
});

test('/api/tg/qr/start returns protective busy backpressure without escalating it as an outage', async () => {
  const logs = [];
  const busy = Object.assign(new Error('Сейчас входит слишком много пользователей — попробуйте снова через минуту'), {
    status: 503,
    code: 'too_many_pending',
    busy: true,
    retryAfter: 60,
  });
  const routes = tgHandlers({
    db: { enabled: true },
    mtprotoFetch: async () => ({}),
    mtprotoPost: async () => { throw busy; },
    tgCrypto: { configured: () => true },
    log: (level, event, meta) => logs.push({ level, event, meta }),
  });

  const response = await invokeRoute(routes.get('POST /api/tg/qr/start').at(-1));
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.retry_after, 60);
  assert.match(response.body.error, /минуту/);
  assert.deepEqual(logs, [{ level: 'warn', event: 'tg_qr_start_busy', meta: { code: 'too_many_pending' } }]);
});

test('central /api/tg/full prefers the managed snapshot and marks it source="managed"', async () => {
  const snap = { data: { channel: { title: 'Central', username: 'central', memberCount: 1234 }, views_summary: { total_views: 9 }, posts: [{ id: 3 }], channel_photo: 'large-private-transport-field' } };
  const calls = [];
  const handler = tgHandlers({
    db: { enabled: true, getSnapshotForActor: async (id, actor) => { calls.push([id, actor.uid]); return snap; } },
    mtprotoFetch: async (path) => { calls.push(path); return {}; },
  }).get('GET /api/tg/full').at(-1);

  const res = await invoke(handler);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'managed');
  assert.deepEqual(res.body.channel, snap.data.channel);
  assert.deepEqual(res.body.posts, [{ id: 3 }]);
  assert.equal(res.body.mtproto_available, true);
  assert.equal(res.body.channel_photo, undefined, 'top-level avatar blob never rides normal dashboard JSON');
  assert.deepEqual(calls, [[7, 11]]);   // read the snapshot; NO live mtproto fetch
});

test('central /api/tg/full falls back to the live global branch when no managed snapshot exists', async () => {
  const calls = [];
  const handler = tgHandlers({
    db: { enabled: true, getSnapshotForActor: async () => null, listPostsForActor: async () => [] },
    mtprotoFetch: async (path) => {
      calls.push(path);
      if (path === '/channel') return { members: 1000 };
      if (path === '/views_summary') return { posts_analyzed: 1 };
      if (path === '/posts') return { posts: [{ id: 9 }] };
      throw new Error(`unexpected ${path}`);
    },
  }).get('GET /api/tg/full').at(-1);

  const res = await invoke(handler);

  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.source, 'managed');       // live global branch, not the managed snapshot
  assert.ok(calls.includes('/channel'), 'live mtproto branch ran');
  assert.deepEqual(res.body.posts, [{ id: 9 }]);
});

test('/api/tg/qr/status derives central_owner server-side (never from client)', async () => {
  const handlerOwner = tgHandlers({
    db: {
      enabled: true,
      getTgSession: async () => null,
      getOwnerChannelId: async () => 5,
      getChannelById: async (id) => (id === 5 ? { id: 5, source: 'central', owner_uid: 11 } : null),
    },
    tgCrypto: { configured: () => true },
    mtprotoPost: async () => ({}),
  }).get('GET /api/tg/qr/status').at(-1);

  const owner = await invokeRoute(handlerOwner, { user: { uid: 11 } });
  assert.equal(owner.body.central_owner, true);

  const handlerStranger = tgHandlers({
    db: {
      enabled: true,
      getTgSession: async () => null,
      getOwnerChannelId: async () => 5,
      getChannelById: async () => ({ id: 5, source: 'central', owner_uid: 999 }),
    },
    tgCrypto: { configured: () => true },
    mtprotoPost: async () => ({}),
  }).get('GET /api/tg/qr/status').at(-1);

  const stranger = await invokeRoute(handlerStranger, { user: { uid: 11 } });
  assert.equal(stranger.body.central_owner, false);
});

test('/api/tg/full serves archived posts without a live /posts request', async () => {
  const calls = [];
  const archived = [{ id: 42, date: '2026-07-12T10:00:00Z', text: 'archived', views: 900 }];
  const handler = fullHandler({
    db: {
      enabled: true,
      getSnapshotForActor: async () => null,   // no managed snapshot → live global branch
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
    db: { enabled: true, getSnapshotForActor: async () => null, listPostsForActor: async () => [] },
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
