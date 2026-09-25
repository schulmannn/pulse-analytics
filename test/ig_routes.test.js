'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIgRoutes } = require('../server/routes/ig');
const igMock = require('../server/ig_mock');

// The env single-account fallback (IG_ACCOUNT/IG_TOKEN) is the superuser's own real account.
// resolveIg gates it: a regular user whose channel getChannel() denied must be served MOCK,
// never the env account's data (that would reopen the X-Channel-Id spoof). These route-level
// tests pin the gate so a refactor that drops the role check fails here, not in production.

const ENV_ACCOUNT = 'env_account_17800';
const ENV_TOKEN = 'env-real-token';

function createIgRoutes(over = {}) {
  const routes = new Map();
  const graphCalls = [];
  const historyCalls = [];
  const statusCalls = [];
  const app = { get(path, ...handlers) { routes.set(path, handlers); } };
  // Гейт владения живёт в ForActor-ридерах (analyticsRepo.gated): фейк повторяет его контракт —
  // чужой канал → пустое той же формы. owns(channelId, actor) задаёт доступ.
  const owns = over.owns || (() => false);
  const db = {
    enabled: true,
    getChannel: async () => null,
    getIgAccount: async () => null,
    listIgDailyForActor: async (channelId, actor, window) => {
      historyCalls.push({ channelId, actor, window });
      return owns(channelId, actor) ? [{ day: '2026-07-01', reach: 5 }] : [];
    },
    getIgArchiveStatusForActor: async (channelId, actor) => {
      statusCalls.push({ channelId, actor });
      return owns(channelId, actor)
        ? { bounds: { first_day: '2024-10-01', last_day: '2026-07-01' }, measured_days: 540,
          backfill: { status: 'running', horizon_day: '2024-10-01', cursor_day: '2024-09-30', reason: null } }
        : null;
    },
    ...over.db,
  };
  registerIgRoutes({
    app,
    requireAuth: (_req, _res, next) => next(),
    db,
    log: () => {},
    igFetch: async (path, _params, token) => {
      graphCalls.push({ path, token });
      return { username: 'real-graph-data' };
    },
    refreshIgIfNeeded: async (_channelId, token) => token,
    igConfigured: () => true,
    igCrypto: over.igCrypto || { configured: () => true, decrypt: () => 'channel-token' },
    igMock,
    nearestOf: (value, allowed) => (allowed.includes(value) ? value : allowed[0]),
    cacheGet: () => undefined,
    cacheSet: () => {},
    IG_ACCOUNT: ENV_ACCOUNT,
    IG_TOKEN: ENV_TOKEN,
    fetchWithTimeout: async () => { throw new Error('no network in tests'); },
    AUTH_SECRET: 'test-secret',
  });
  return { routes, graphCalls, historyCalls, statusCalls };
}

async function invoke(routes, path, { user, query = {} } = {}) {
  const handlers = routes.get(path);
  assert.ok(handlers, `route ${path} is registered`);
  const req = { query, headers: {}, user };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

test('regular user with a denied channel is served mock, not the env account', async () => {
  const { routes, graphCalls } = createIgRoutes(); // getChannel → null = access denied
  const res = await invoke(routes, '/api/ig/profile', {
    user: { uid: 7, role: 'user' },
    query: { channel: '42' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mock, true);
  assert.equal(res.body.username, igMock.igMockProfile().username);
  assert.equal(graphCalls.length, 0, 'the env token must never be spent for a denied channel');
});

test('superuser is served the env single-account fallback', async () => {
  const { routes, graphCalls } = createIgRoutes();
  const res = await invoke(routes, '/api/ig/profile', {
    user: { uid: 1, role: 'superuser' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.username, 'real-graph-data');
  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].path, `/${ENV_ACCOUNT}`);
  assert.equal(graphCalls[0].token, ENV_TOKEN);
});

test('channel owner is served their connected account with the channel token', async () => {
  const { routes, graphCalls } = createIgRoutes({
    db: {
      getChannel: async (channelId, user) => ({ id: channelId, owner: user.uid }),
      getIgAccount: async () => ({
        ig_user_id: 'own_ig_999',
        access_token_enc: 'enc-blob',
        username: 'own',
        token_expires_at: null,
      }),
    },
  });
  const res = await invoke(routes, '/api/ig/profile', {
    user: { uid: 7, role: 'user' },
    query: { channel: '42' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.username, 'real-graph-data');
  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].path, '/own_ig_999');
  assert.equal(graphCalls[0].token, 'channel-token', 'channel OAuth token, not the env token');
});

test('decrypt failure for a regular user falls back to mock, never to the env account', async () => {
  const { routes, graphCalls } = createIgRoutes({
    db: {
      getChannel: async (channelId) => ({ id: channelId }),
      getIgAccount: async () => ({ ig_user_id: 'own_ig_999', access_token_enc: 'enc-blob' }),
    },
    igCrypto: { configured: () => true, decrypt: () => { throw new Error('bad key'); } },
  });
  const res = await invoke(routes, '/api/ig/profile', {
    user: { uid: 7, role: 'user' },
    query: { channel: '42' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mock, true);
  assert.equal(graphCalls.length, 0);
});

test('db-less local dev serves the env fallback to any user', async () => {
  const { routes, graphCalls } = createIgRoutes({ db: { enabled: false } });
  const res = await invoke(routes, '/api/ig/profile', {
    user: { uid: 7, role: 'user' },
  });

  assert.equal(res.body.username, 'real-graph-data');
  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].token, ENV_TOKEN);
});

// ── GET /api/ig/history — архив ig_daily (OD-13: без потолка, без живого токена) ────────────────

const OWNER = { uid: 7, role: 'user' };
const ownerOf42 = (channelId, actor) => channelId === 42 && actor && actor.uid === 7;

test('ig history: владелец читает архив без живого токена — ни resolveIg, ни Graph, ни дешифровки', async () => {
  let decrypts = 0;
  const { routes, historyCalls, graphCalls } = createIgRoutes({
    owns: ownerOf42,
    igCrypto: { configured: () => false, decrypt: () => { decrypts++; throw new Error('key rotated'); } },
  });
  const res = await invoke(routes, '/api/ig/history', { user: OWNER, query: { channel: '42', days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows, [{ day: '2026-07-01', reach: 5 }]);
  assert.deepEqual(historyCalls[0].window, { all: true }, '«Всё» — без нижней границы');
  assert.deepEqual(res.body.bounds, { first_day: '2024-10-01', last_day: '2026-07-01' });
  assert.deepEqual(res.body.window, { from: '2024-10-01', to: '2026-07-01' }, '«Всё» материализуется размахом архива');
  assert.deepEqual(res.body.coverage, { measured_days: 540 });
  assert.equal(res.body.backfill.status, 'running');
  assert.equal(graphCalls.length, 0);
  assert.equal(decrypts, 0, 'архив переживает протухший токен и ротацию ключа');
});

test('ig history: чужой канал — пустой архив той же формы', async () => {
  const { routes, historyCalls } = createIgRoutes({ owns: ownerOf42 });
  const res = await invoke(routes, '/api/ig/history', { user: { uid: 8, role: 'user' }, query: { channel: '42', days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows, []);
  assert.equal(res.body.bounds, null);
  assert.equal(res.body.backfill, null);
  assert.deepEqual(historyCalls[0].actor, { uid: 8, role: 'user' }, 'гейт владения получает актора запроса');
});

test('ig history: без канала (env/superuser-путь) — rows:[] без обращения к архиву', async () => {
  const { routes, historyCalls } = createIgRoutes({ owns: () => true });
  const res = await invoke(routes, '/api/ig/history', { user: { uid: 1, role: 'superuser' }, query: { days: '0' } });
  assert.deepEqual(res.body.rows, []);
  assert.equal(historyCalls.length, 0);
});

test('ig history: from/to — точный диапазон любой длины; кривой диапазон — 400 bad_period', async () => {
  const { routes, historyCalls } = createIgRoutes({ owns: ownerOf42 });
  const ok = await invoke(routes, '/api/ig/history', { user: OWNER, query: { channel: '42', from: '2023-01-01', to: '2025-12-31' } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(historyCalls[0].window, { from: '2023-01-01', to: '2025-12-31' }, 'широкий диапазон не обрезается (OD-13)');
  assert.deepEqual(ok.body.window, { from: '2023-01-01', to: '2025-12-31' });
  for (const query of [
    { from: '2025-02-01', to: '2025-01-01' },
    { from: '2025-02-30', to: '2025-03-01' },
    { from: '2025-01-01' },
    { from: ['2025-01-01', '2025-01-02'], to: '2025-02-01' },
  ]) {
    const bad = await invoke(routes, '/api/ig/history', { user: OWNER, query: { channel: '42', ...query } });
    assert.equal(bad.statusCode, 400, JSON.stringify(query));
    assert.equal(bad.body.code, 'bad_period');
  }
  assert.equal(historyCalls.length, 1, 'кривой диапазон не читает архив');
});

test('ig history: legacy days — число дней без потолка 1000, не меньше 1, по умолчанию 400', async () => {
  const { routes, historyCalls } = createIgRoutes({ owns: ownerOf42 });
  for (const days of ['30', '1500', '-3', undefined, 'abc']) {
    await invoke(routes, '/api/ig/history', { user: OWNER, query: { channel: '42', ...(days === undefined ? {} : { days }) } });
  }
  assert.deepEqual(historyCalls.map((c) => c.window), [30, 1500, 1, 400, 400]);
});

test('ig history: сбой чтения — оформленный 200 с пустыми rows', async () => {
  const { routes } = createIgRoutes({
    owns: ownerOf42,
    db: { listIgDailyForActor: async () => { throw new Error('db down'); } },
  });
  const res = await invoke(routes, '/api/ig/history', { user: OWNER, query: { channel: '42', days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows, []);
  assert.equal(res.body.error, 'История временно недоступна');
});
