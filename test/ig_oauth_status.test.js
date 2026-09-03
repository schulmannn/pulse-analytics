'use strict';

// GET /api/ig/oauth/status отдаёт token_state — срок доступа Instagram в машинном виде.
// До этого поля статус говорил только «connected: true», то есть «строка в БД есть»; экран
// Instagram и пилюля источника из него не могли отличить рабочий аккаунт от протухшего и держали
// скелетон. Здесь пришпилена таблица «дата → состояние» и совместимость существующих полей.

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIgOauthRoutes } = require('../server/routes/ig-oauth');

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

// Минимальный стенд: из всего набора роутов нам нужен только status-хендлер.
function statusHandler({ account = null, channelExists = true } = {}) {
  const handlers = new Map();
  const app = {
    post: (p, ...h) => handlers.set(`POST ${p}`, h[h.length - 1]),
    get: (p, ...h) => handlers.set(`GET ${p}`, h[h.length - 1]),
    delete: (p, ...h) => handlers.set(`DELETE ${p}`, h[h.length - 1]),
  };
  registerIgOauthRoutes({
    app,
    db: {
      enabled: true,
      getChannel: async (id) => (channelExists && id === 42 ? { id: 42, owner_uid: 1 } : null),
      getIgAccount: async () => account,
    },
    requireAuth: (_req, _res, next) => next(),
    audit: async () => {},
    log: () => {},
    fetchWithTimeout: async () => { throw new Error('no network in tests'); },
    asyncHandler: (fn) => fn,
    appBase: () => 'https://app.test',
    cache: { keys: () => [], delete: () => {} },
    igConfigured: () => false,
    igCrypto: { configured: () => true, encrypt: (t) => `enc(${t})` },
    AUTH_SECRET: 'test-secret',
    IG_GRAPH: 'https://graph.instagram.com',
    IG_CLIENT_ID: 'cid',
    IG_CLIENT_SECRET: 'csecret',
    oauthMaxInFlight: 4,
    oauthAcquireTimeoutMs: 1000,
  });
  return handlers.get('GET /api/ig/oauth/status');
}

async function call(handler) {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ query: {}, headers: { 'x-channel-id': '42' }, user: { id: 1, role: 'user' } }, res);
  return res.body;
}

const account = (expiresAt) => ({
  ig_user_id: 'igid123', username: 'creator', connected_at: '2026-07-03T10:00:00',
  token_expires_at: expiresAt,
});

test('token_state: ok / expiring / expired по трём датам', async () => {
  assert.equal((await call(statusHandler({ account: account(inDays(30)) }))).token_state, 'ok');
  assert.equal((await call(statusHandler({ account: account(inDays(3)) }))).token_state, 'expiring');
  assert.equal((await call(statusHandler({ account: account(inDays(-2)) }))).token_state, 'expired');
});

test('без подключённого аккаунта — none, connected остаётся false', async () => {
  const body = await call(statusHandler({ account: null }));
  assert.equal(body.token_state, 'none');
  assert.equal(body.connected, false);
});

test('строка аккаунта без срока не выдумывает тревогу', async () => {
  const body = await call(statusHandler({ account: account(null) }));
  assert.equal(body.token_state, 'none');
  assert.equal(body.connected, true);
});

test('существующие поля статуса на месте: новое поле ничего не вытеснило', async () => {
  const acc = account(inDays(-2));
  const body = await call(statusHandler({ account: acc }));
  assert.equal(body.connected, true);
  assert.equal(body.username, 'creator');
  assert.equal(body.ig_user_id, 'igid123');
  assert.equal(body.channel_id, 42);
  assert.equal(body.connected_at, '2026-07-03T10:00:00');
  assert.equal(body.token_expires_at, acc.token_expires_at);
  assert.equal(typeof body.server_ready, 'boolean');
  assert.equal(typeof body.env_fallback, 'boolean');
});

test('чужой канал: аккаунт не читается, состояние честное none', async () => {
  const body = await call(statusHandler({ account: account(inDays(30)), channelExists: false }));
  assert.equal(body.connected, false);
  assert.equal(body.token_state, 'none');
});
