'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerMentionsRoutes } = require('../server/routes/mentions');

function createRoutes(overrides = {}) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
  };
  const db = {
    enabled: true,
    getMentionSettingsForActor: async () => ({
      configured: true,
      include_terms: ['Brand'],
      exclude_terms: ['spam'],
      exclude_sources: ['noise'],
      match_mode: 'contains',
      revision: 3,
      updated_at: '2026-07-15T12:00:00+00:00',
    }),
    upsertMentionSettingsForActor: async (_id, _actor, rules) => ({
      ...rules,
      configured: true,
      revision: 4,
      updated_at: '2026-07-15T12:01:00+00:00',
    }),
    getTgSession: async () => ({
      uid: 11,
      session_enc: 'encrypted',
      session_version: '7',
      connection_state: 'healthy',
    }),
    upsertMentions: async () => 1,
    recordTgSessionSuccess: async () => true,
    recordTgSessionFailure: async () => true,
    ...overrides.db,
  };
  const calls = { audit: [], logs: [], cache: [] };
  registerMentionsRoutes({
    app,
    requireAuth: (_req, _res, next) => next(),
    resolveChannel: (_req, _res, next) => next(),
    db,
    audit: async (_req, action, metadata) => { calls.audit.push({ action, metadata }); },
    log: (level, event, metadata) => calls.logs.push({ level, event, metadata }),
    cacheGet: overrides.cacheGet || (() => null),
    cacheSet: overrides.cacheSet || ((key, value) => calls.cache.push({ key, value })),
    tgCrypto: overrides.tgCrypto || { configured: () => true, decrypt: () => 'plaintext-session' },
    mtprotoClient: {
      MTPROTO_TOKEN: 'internal-token',
      MTPROTO_TIMEOUT_HEAVY_MS: 120000,
      mtprotoPost: overrides.mtprotoPost || (async () => ({ available: true, all: [] })),
      sendMtprotoError: (res, err) => res.status(err.status || 503).json({ error: err.message }),
      ...overrides.mtprotoClient,
    },
  });
  return { routes, db, calls };
}

async function invoke(handlers, req = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(body) { this.body = body; return this; },
  };
  let nextError = null;
  const request = {
    body: {},
    user: { uid: 11 },
    channel: {
      id: 7,
      owner_uid: 11,
      member_role: 'owner',
      username: 'own_brand',
      tg_channel_id: '777',
    },
    ...req,
  };
  await handlers.at(-1)(request, res, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return res;
}

test('GET settings exposes selected-channel rules and server-derived edit/own-source state', async () => {
  const { routes } = createRoutes();
  const res = await invoke(routes.get('GET /api/tg/mention-settings'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.can_edit, true);
  assert.equal(res.body.revision, 3);
  assert.deepEqual(res.body.rules.include_terms, ['Brand']);
  assert.deepEqual(res.body.own_source, { username: 'own_brand', tg_channel_id: '777' });
});

test('PUT settings normalizes input, stores through actor gate and audits no rule text', async () => {
  let savedRules;
  const { routes, calls } = createRoutes({
    db: {
      upsertMentionSettingsForActor: async (_id, _actor, rules) => {
        savedRules = rules;
        return { ...rules, configured: true, revision: 9, updated_at: 'now' };
      },
    },
  });
  const res = await invoke(routes.get('PUT /api/tg/mention-settings'), {
    body: {
      include_terms: ['  Nōtem ', 'notem', 'нотем'],
      exclude_terms: [' spam '],
      exclude_sources: ['@Noise'],
      match_mode: 'word',
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(savedRules.include_terms, ['Nōtem', 'notem', 'нотем']);
  assert.deepEqual(savedRules.exclude_sources, ['noise']);
  assert.equal(calls.audit[0].action, 'tg.mention_settings.updated');
  assert.deepEqual(calls.audit[0].metadata, {
    channel_id: 7, include: 3, exclude: 1, sources: 1, match_mode: 'word',
  });
  assert.doesNotMatch(JSON.stringify(calls.audit), /Nōtem|нотем|spam|Noise/);
});

test('viewer can read settings but cannot save rules or spend search quota', async () => {
  let upstream = 0;
  const { routes } = createRoutes({ mtprotoPost: async () => { upstream += 1; return {}; } });
  const channel = { id: 7, owner_uid: 99, member_role: 'viewer', username: 'shared' };

  const read = await invoke(routes.get('GET /api/tg/mention-settings'), { channel });
  const write = await invoke(routes.get('PUT /api/tg/mention-settings'), {
    channel, body: { include_terms: ['x'] },
  });
  const search = await invoke(routes.get('GET /api/tg/mtproto/mentions'), { channel });

  assert.equal(read.statusCode, 200);
  assert.equal(read.body.can_edit, false);
  assert.equal(write.statusCode, 403);
  assert.equal(search.statusCode, 403);
  assert.equal(upstream, 0);
});

test('live search requires configured rules before reading a Telegram session', async () => {
  let sessionReads = 0;
  const { routes } = createRoutes({
    db: {
      getMentionSettingsForActor: async () => ({
        configured: false, include_terms: [], exclude_terms: [], exclude_sources: [],
        match_mode: 'contains', revision: 0, updated_at: null,
      }),
      getTgSession: async () => { sessionReads += 1; return null; },
    },
  });
  const res = await invoke(routes.get('GET /api/tg/mtproto/mentions'));
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /не настроены/);
  assert.equal(sessionReads, 0);
});

test('channel cache never masks a missing caller Telegram session', async () => {
  let upstream = 0;
  const { routes } = createRoutes({
    cacheGet: () => ({ available: true, total: 99 }),
    mtprotoPost: async () => { upstream += 1; return {}; },
    db: { getTgSession: async () => null },
  });

  const res = await invoke(routes.get('GET /api/tg/mtproto/mentions'));

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'no_session');
  assert.equal(upstream, 0);
});

test('live search uses only caller managed session, selected-channel rules and revision cache key', async () => {
  const events = [];
  let postCall;
  const { routes, calls } = createRoutes({
    mtprotoPost: async (path, options) => {
      postCall = { path, options };
      return {
        available: true,
        total: 1,
        all: [{ channel_id: 55, msg_id: 99, views: 100, query: 'Brand' }],
      };
    },
    db: {
      upsertMentions: async (channelId, rows) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(['persisted', channelId, rows.length]);
      },
      recordTgSessionSuccess: async (_uid, version) => { events.push(['healthy', version]); },
    },
    cacheSet: (key, body) => {
      assert.equal(body.all, undefined);
      events.push(['cached', key]);
    },
  });
  const res = await invoke(routes.get('GET /api/tg/mtproto/mentions'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.all, undefined);
  assert.equal(postCall.path, '/mentions/search');
  assert.equal(postCall.options.timeoutMs, 120000);
  assert.deepEqual(postCall.options.body, {
    session: 'plaintext-session',
    include_terms: ['Brand'],
    exclude_terms: ['spam'],
    exclude_sources: ['noise', 'own_brand'],
    exclude_channel_ids: ['777'],
    match_mode: 'contains',
  });
  assert.deepEqual(events, [
    ['healthy', '7'],
    ['persisted', 7, 1],
    ['cached', 'mtproto:mentions:7:r3'],
  ]);
  assert.equal(calls.logs.length, 0);
});

test('live search fails closed when archive persistence fails and never caches', async () => {
  let cached = false;
  const { routes, calls } = createRoutes({
    db: { upsertMentions: async () => { throw new Error('password=do-not-leak'); } },
    mtprotoPost: async () => ({
      available: true,
      all: [{ channel_id: 55, msg_id: 99 }],
    }),
    cacheSet: () => { cached = true; },
  });
  const res = await invoke(routes.get('GET /api/tg/mtproto/mentions'));

  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(res.body.error, /password|do-not-leak/i);
  assert.equal(cached, false);
  assert.equal(calls.logs[0].event, 'mentions_archive_write_failed');
});

test('managed session auth failure marks only its generation reauth_required', async () => {
  const health = [];
  const authError = Object.assign(new Error('unauthorized'), { status: 401, code: 'session_unauthorized' });
  const { routes } = createRoutes({
    mtprotoPost: async () => { throw authError; },
    db: {
      recordTgSessionFailure: async (...args) => { health.push(args); return true; },
    },
  });
  const res = await invoke(routes.get('GET /api/tg/mtproto/mentions'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'reauth_required');
  assert.deepEqual(health, [[11, '7', {
    state: 'reauth_required', errorCode: 'session_unauthorized',
  }]]);
});
