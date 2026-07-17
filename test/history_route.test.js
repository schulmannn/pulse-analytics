'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerHistoryRoutes } = require('../server/routes/history');

const SECRET_DB_ERROR = 'password=hunter2 host=db.internal SELECT * FROM secrets';

function createRoute(over = {}) {
  const routes = new Map();
  const calls = [];
  const logs = [];
  const app = {
    get(path, ...handlers) { routes.set(path, handlers); },
  };
  const db = {
    enabled: true,
    getMentionsArchiveForActor: async (channelId, actor, options) => {
      calls.push({ channelId, actor, options });
      return { available: true, total: 0 };
    },
    getChannelHistoryForActor: async () => [],
    ...over,
  };
  const pass = (_req, _res, next) => next();
  registerHistoryRoutes({
    app,
    requireAuth: pass,
    resolveChannel: pass,
    db,
    log: (level, event, meta) => logs.push({ level, event, meta }),
  });
  return {
    handlers: routes.get('/api/history/mentions'),
    channelHandlers: routes.get('/api/history/channel'),
    calls,
    logs,
  };
}

async function invoke(handlers, query = {}) {
  const req = { query, channel: { id: 7 }, user: { uid: 11 } };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handlers.at(-1)(req, res);
  return res;
}

test('mentions history forwards a valid inclusive custom range and lets it override days', async () => {
  const { handlers, calls } = createRoute();
  const res = await invoke(handlers, {
    days: '90', from: '2026-06-10', to: '2026-06-12', source: '55', limit: '500',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {
    days: 90,
    limit: 100,
    source: '55',
    range: { from: '2026-06-10', to: '2026-06-12' },
  });
});

test('mentions history rejects partial, malformed, impossible and reversed ranges before DB access', async () => {
  for (const query of [
    { from: '2026-06-10' },
    { from: '2026-6-10', to: '2026-06-12' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-06-12', to: '2026-06-10' },
  ]) {
    const { handlers, calls } = createRoute();
    const res = await invoke(handlers, query);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.match(res.body.error, /from.*to.*YYYY-MM-DD/);
    assert.equal(calls.length, 0);
  }
});

test('mentions history keeps the legacy preset contract when no custom range is requested', async () => {
  const { handlers, calls } = createRoute();
  const res = await invoke(handlers, { days: '30' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].options, { days: 30, limit: 30, source: undefined, range: null });
});

test('mentions history degrades to a shaped 200 without leaking the raw DB error message', async () => {
  const { handlers, logs } = createRoute({
    getMentionsArchiveForActor: async () => { throw new Error(SECRET_DB_ERROR); },
  });
  const res = await invoke(handlers, { days: '30' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.available, false);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(!res.body.error.includes('hunter2'), 'raw DB error must not leak to the client');
  assert.ok(!res.body.error.includes('SELECT'), 'no SQL internals in the degradation message');
  assert.ok(logs.some((entry) => entry.event === 'history_mentions_read_failed'));
  assert.ok(!JSON.stringify(logs).includes('hunter2'), 'raw DB error is not copied into logs either');
});

test('channel history degrades to a shaped 200 (empty rows, stable error) and passes radix-10 days', async () => {
  const seen = [];
  const { channelHandlers, logs } = createRoute({
    getChannelHistoryForActor: async (channelId, actor, days) => { seen.push(days); throw new Error(SECRET_DB_ERROR); },
  });
  const req = { query: { days: '08' }, channel: { id: 7 }, user: { uid: 11 } };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await channelHandlers.at(-1)(req, res);

  assert.equal(seen[0], 8, "parseInt uses radix 10 — '08' is 8, not NaN");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows, []);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(!res.body.error.includes('hunter2'), 'raw DB error must not leak to the client');
  assert.ok(logs.some((entry) => entry.event === 'history_channel_read_failed'));
});
