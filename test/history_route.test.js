'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerHistoryRoutes } = require('../server/routes/history');

function createRoute() {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path, ...handlers) { routes.set(path, handlers); },
  };
  const db = {
    enabled: true,
    getMentionsArchiveForActor: async (channelId, actor, options) => {
      calls.push({ channelId, actor, options });
      return { available: true, total: 0 };
    },
  };
  const pass = (_req, _res, next) => next();
  registerHistoryRoutes({ app, requireAuth: pass, resolveChannel: pass, db });
  return { handlers: routes.get('/api/history/mentions'), calls };
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
