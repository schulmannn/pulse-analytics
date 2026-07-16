'use strict';

// Route-тесты GET /api/ig/tags (fake-app паттерн history_route/reports_route): проверяем tenant-scope
// архива тегов после миграции 026. Фокус — resolveIg выбирает БЕЗОПАСНЫЙ channel-scope, а хендлер
// пишет/читает архив ТОЛЬКО в нём:
//   • per-channel OAuth-подключение — архивирует и отдаёт по своему channel_id;
//   • superuser env-fallback архивирует только при actor-access + совпавшей persisted IG identity;
//   • env-fallback БЕЗ доказанной identity остаётся live-only (upsert не зовётся);
//   • обычный юзер на чужой канал — mock (ни env-данных, ни архива).

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIgRoutes } = require('../server/routes/ig');

// Собирает роуты с настраиваемыми зависимостями и записывает все вызовы db-архива.
function build(over = {}) {
  const calls = { upsert: [], read: [] };
  const routes = new Map();
  const app = { get(path, ...h) { routes.set(`GET ${path}`, h); } };
  const pass = (_req, _res, next) => next();
  const deps = {
    app,
    requireAuth: pass,
    log: () => {},
    igFetch: over.igFetch || (async () => ({ data: [{ id: 'live1', username: 'fan', caption: 'live' }] })),
    refreshIgIfNeeded: async (_c, token) => token,
    igConfigured: over.igConfigured || (() => true),
    igCrypto: { configured: over.cryptoConfigured || (() => true), decrypt: () => 'tok' },
    igMock: { igMockTags: () => ({ data: [], mock: true }) },
    nearestOf: (v) => v,
    cacheGet: () => null,
    cacheSet: () => {},
    IG_ACCOUNT: 'envacct',
    IG_TOKEN: 'envtok',
    db: {
      enabled: over.enabled !== undefined ? over.enabled : true,
      getChannel: over.getChannel || (async () => ({ id: 7 })),
      getIgAccount: over.getIgAccount || (async () => ({ ig_user_id: 'chan-acct', access_token_enc: 'enc', token_expires_at: null, username: 'me' })),
      upsertIgTags: async (channelId, rows) => { calls.upsert.push({ channelId, rows }); return rows.length; },
      listIgTagsForActor: async (channelId, actor, limit) => { calls.read.push({ channelId, actor, limit }); return [{ id: 'arch1', source: 'db' }]; },
    },
  };
  registerIgRoutes(deps);
  return { routes, calls };
}

async function invoke(routes, { query = {}, user = { uid: 11 }, headers = {} } = {}) {
  const handlers = routes.get('GET /api/ig/tags'); // [requireAuth, resolveIg, handler]
  const req = { query, user, headers };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  for (let i = 0; i < handlers.length; i++) {
    const isLast = i === handlers.length - 1;
    let called = false;
    await handlers[i](req, res, () => { called = true; });
    if (isLast) break;
    if (!called) break; // middleware short-circuited (не позвал next)
  }
  return res;
}

test('per-channel OAuth: архивирует live под своим channel_id и отдаёт архив', async () => {
  const { routes, calls } = build();
  const res = await invoke(routes, { query: { channel: '7' } });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.upsert.length, 1);
  assert.equal(calls.upsert[0].channelId, 7, 'upsert в channel-scope 7');
  assert.equal(calls.read.length, 1);
  assert.equal(calls.read[0].channelId, 7);
  assert.deepEqual(res.body.data, [{ id: 'arch1', source: 'db' }], 'отдаётся архив, не сырое live');
  assert.equal(res.body.live_count, 1);
});

test('superuser env-fallback with matching persisted IG identity archives into that channel', async () => {
  const { routes, calls } = build({
    // Identity is proven, but there is no usable encrypted token, so resolveIg takes the env path.
    getIgAccount: async () => ({ ig_user_id: 'envacct', access_token_enc: null }),
  });
  const res = await invoke(routes, { query: { channel: '7' }, user: { uid: 1, role: 'superuser' } });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.upsert.length, 1, 'env-fallback всё равно архивирует…');
  assert.equal(calls.upsert[0].channelId, 7, '…но ТОЛЬКО в авторизованный channel-scope');
  assert.equal(calls.read[0].channelId, 7);
});

test('superuser env-fallback with no or mismatched IG identity stays live-only', async () => {
  for (const getIgAccount of [
    async () => null,
    async () => ({ ig_user_id: 'another-account', access_token_enc: null }),
  ]) {
    const { routes, calls } = build({ getIgAccount });
    const res = await invoke(routes, { query: { channel: '7' }, user: { uid: 1, role: 'superuser' } });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.upsert.length, 0, 'unverified env identity must not contaminate a channel archive');
    assert.equal(calls.read.length, 0);
    assert.deepEqual(res.body.data, [{ id: 'live1', username: 'fan', caption: 'live' }]);
  }
});

test('superuser env-fallback БЕЗ канала: live-only, архив не трогаем', async () => {
  const { routes, calls } = build();
  const res = await invoke(routes, { query: {}, user: { uid: 1, role: 'superuser' } });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.upsert.length, 0, 'нет безопасного channel-scope → не архивируем');
  assert.equal(calls.read.length, 0, 'архив не читаем — отдаём live');
  assert.deepEqual(res.body.data, [{ id: 'live1', username: 'fan', caption: 'live' }]);
});

test('обычный юзер на чужой/недоступный канал: mock (ни env-данных, ни архива)', async () => {
  const { routes, calls } = build({
    getChannel: async () => null, // нет доступа
  });
  const res = await invoke(routes, { query: { channel: '7' }, user: { uid: 11, role: 'user' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mock, true, 'отдаётся connect-prompt mock');
  assert.equal(calls.upsert.length, 0);
  assert.equal(calls.read.length, 0);
});

test('upstream tags fail → отдаёт архив авторизованного scope (honest degradation)', async () => {
  const { routes, calls } = build({
    igFetch: async () => { throw new Error('tags edge down'); },
  });
  const res = await invoke(routes, { query: { channel: '7' } });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.upsert.length, 0, 'нет live → нечего апсертить');
  assert.equal(calls.read.length, 1, 'но архив своего scope всё равно читаем');
  assert.deepEqual(res.body.data, [{ id: 'arch1', source: 'db' }]);
  assert.equal(res.body.live_count, 0);
});
