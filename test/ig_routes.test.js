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
  const app = { get(path, ...handlers) { routes.set(path, handlers); } };
  const db = {
    enabled: true,
    getChannel: async () => null,
    getIgAccount: async () => null,
    listIgDailyForActor: async (channelId, actor, days) => {
      historyCalls.push({ channelId, actor, days });
      return [{ day: '2026-07-01' }];
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
  return { routes, graphCalls, historyCalls };
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

test('ig history reads only the resolved own channel and stays empty when denied', async () => {
  const denied = createIgRoutes();
  const deniedRes = await invoke(denied.routes, '/api/ig/history', {
    user: { uid: 7, role: 'user' },
    query: { channel: '42' },
  });
  assert.deepEqual(deniedRes.body.rows, []);
  assert.equal(denied.historyCalls.length, 0, 'no per-channel read without an authorized channel');

  const owner = createIgRoutes({
    db: {
      getChannel: async (channelId) => ({ id: channelId }),
      getIgAccount: async () => ({ ig_user_id: 'own_ig_999', access_token_enc: 'enc-blob' }),
    },
  });
  const ownerRes = await invoke(owner.routes, '/api/ig/history', {
    user: { uid: 7, role: 'user' },
    query: { channel: '42', days: '30' },
  });
  assert.equal(owner.historyCalls.length, 1);
  assert.equal(owner.historyCalls[0].channelId, 42);
  assert.equal(owner.historyCalls[0].days, 30);
  assert.deepEqual(ownerRes.body.rows, [{ day: '2026-07-01' }]);
});
