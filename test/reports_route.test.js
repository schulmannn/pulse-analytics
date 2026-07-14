'use strict';

// Route-тесты /api/reports (fake-app паттерн campaigns_route): auth — pass-middleware, db — стаб.
// Фокус на новой логике: POST принимает optional schedule (валидация REPORT_SCHEDULES, проброс в
// createReport), обратная совместимость (без schedule → createReport зовётся без 4-го аргумента),
// 503 без БД, bad id, и что список отдаётся как есть (summary-поля добавляет repo, не роут).

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerReportsRoutes } = require('../server/routes/reports');

function buildRoutes(db) {
  const routes = new Map();
  const app = {
    get(path, ...h) { routes.set(`GET ${path}`, h); },
    post(path, ...h) { routes.set(`POST ${path}`, h); },
    put(path, ...h) { routes.set(`PUT ${path}`, h); },
    delete(path, ...h) { routes.set(`DELETE ${path}`, h); },
  };
  const pass = (_req, _res, next) => next();
  registerReportsRoutes({ app, db, requireAuth: pass, audit: async () => {} });
  return routes;
}

async function invoke(routes, key, { params = {}, body = {}, uid = 7 } = {}) {
  const handler = routes.get(key).at(-1);
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let nextError = null;
  await handler({ params, body, user: { uid } }, res, (e) => { nextError = e; });
  if (nextError) throw nextError;
  return res;
}

const REPORT = { id: 3, name: 'Отчёт', config: {}, schedule: 'none', created_at: 'x', updated_at: 'y' };

const baseDb = (over = {}) => ({
  enabled: true,
  REPORT_SCHEDULES: ['none', 'weekly', 'monthly'],
  listReports: async () => [
    { id: 3, name: 'Отчёт', schedule: 'weekly', channel_id: 10, period_days: 30, block_count: 4, last_sent_at: null, created_at: 'x', updated_at: 'y' },
  ],
  getReport: async () => REPORT,
  createReport: async () => REPORT,
  updateReport: async () => REPORT,
  deleteReport: async () => true,
  ...over,
});

test('без БД все эндпоинты → 503 {error}', async () => {
  const routes = buildRoutes({ enabled: false });
  for (const key of routes.keys()) {
    const res = await invoke(routes, key, { params: { id: '3' }, body: { name: 'x' } });
    assert.equal(res.statusCode, 503, key);
    assert.match(res.body.error, /отчёты недоступны/);
  }
});

test('GET /api/reports: список отдаётся с summary-полями как есть', async () => {
  const routes = buildRoutes(baseDb());
  const res = await invoke(routes, 'GET /api/reports');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reports[0].channel_id, 10);
  assert.equal(res.body.reports[0].block_count, 4);
});

test('POST /api/reports: name-валидация', async () => {
  const routes = buildRoutes(baseDb());
  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }]) {
    const res = await invoke(routes, 'POST /api/reports', { body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(res.body.error, /name/);
  }
});

test('POST /api/reports: schedule опционален и валидируется', async () => {
  let received;
  const routes = buildRoutes(baseDb({
    createReport: async (_uid, _name, _config, schedule) => { received = schedule; return REPORT; },
  }));

  // Невалидный schedule → 400, до repo не доходит.
  received = 'UNSET';
  const bad = await invoke(routes, 'POST /api/reports', { body: { name: 'Отчёт', schedule: 'daily' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /schedule/);
  assert.equal(received, 'UNSET');

  // Валидный schedule → пробрасывается 4-м аргументом.
  const ok = await invoke(routes, 'POST /api/reports', { body: { name: 'Отчёт', schedule: 'weekly' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(received, 'weekly');

  // Без schedule → старое поведение: createReport зовётся с undefined (column default стоит).
  received = 'UNSET';
  const legacy = await invoke(routes, 'POST /api/reports', { body: { name: 'Отчёт' } });
  assert.equal(legacy.statusCode, 200);
  assert.equal(received, undefined);
});

test('POST /api/reports: config-валидация формы блоков', async () => {
  const routes = buildRoutes(baseDb());
  const bad = await invoke(routes, 'POST /api/reports', { body: { name: 'ok', config: { blocks: 'nope' } } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /blocks/);
});

test('bad id: не-числовой :id → 400 на /:id-роутах', async () => {
  const routes = buildRoutes(baseDb());
  for (const key of [...routes.keys()].filter((k) => k.includes(':id'))) {
    const res = await invoke(routes, key, { params: { id: 'abc' }, body: { name: 'x' } });
    assert.equal(res.statusCode, 400, key);
    assert.equal(res.body.error, 'bad id');
  }
});

test('404 без утечки: чужой/несуществующий отчёт на GET/PUT/DELETE', async () => {
  const routes = buildRoutes(baseDb({ getReport: async () => null, updateReport: async () => null, deleteReport: async () => false }));
  for (const [key, body] of [
    ['GET /api/reports/:id', {}],
    ['PUT /api/reports/:id', { name: 'x' }],
    ['DELETE /api/reports/:id', {}],
  ]) {
    const res = await invoke(routes, key, { params: { id: '3' }, body });
    assert.equal(res.statusCode, 404, key);
  }
});
