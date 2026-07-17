'use strict';

// Route-тесты GET /api/account/export (fake-app паттерн reports_route). Фокус на контракте роута
// вокруг стриминг-экспорта db.streamUserExport (застаблен по исходам):
//   • not_found → чистый 404 без заголовков стрима и без аудита;
//   • ok → no-store/content-disposition/content-type ставятся onReady ДО первого байта, аудит —
//     ровно один раз и только после завершения, второго ответа поверх стрима нет;
//   • aborted / stream_error → ни второго ответа, ни аудита (ответ уже завершён/уничтожен);
//   • throw ДО стрима → next(error);
//   • без БД → 503.
// Лимитер и requireAuth здесь pass-through (берём последний хендлер, как в reports_route).

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAccountRoutes } = require('../server/routes/account');

function buildRoutes(db, audit) {
  const routes = new Map();
  const app = {
    get(path, ...h) { routes.set(`GET ${path}`, h); },
    put() {}, post() {}, patch() {}, delete() {},
  };
  const pass = (_req, _res, next) => next();
  registerAccountRoutes({
    app, requireAuth: pass, requireSuper: pass, db,
    audit, sendEmail: async () => {}, emailShell: () => '', GOOGLE_CLIENT_ID: null,
  });
  return routes;
}

function fakeRes() {
  return {
    statusCode: 200, headers: {}, jsonCalls: 0, body: undefined, destroyed: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonCalls += 1; this.body = payload; return this; },
    destroy() { this.destroyed = true; },
  };
}

async function invokeExport(db, audit = async () => {}) {
  const routes = buildRoutes(db, audit);
  const handler = routes.get('GET /api/account/export').at(-1);
  const res = fakeRes();
  let nextError = null;
  await handler({ user: { uid: 7 } }, res, (e) => { nextError = e; });
  return { res, nextError };
}

test('export: not_found → чистый 404 без заголовков стрима и без аудита', async () => {
  let audited = 0;
  // streamUserExport не зовёт onReady (юзера нет) → ни одного заголовка стрима.
  const db = { enabled: true, streamUserExport: async () => 'not_found' };
  const { res, nextError } = await invokeExport(db, async () => { audited += 1; });
  assert.equal(nextError, null);
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['Cache-Control'], undefined);
  assert.equal(res.headers['Content-Disposition'], undefined);
  assert.equal(res.headers['Content-Type'], undefined);
  assert.equal(audited, 0);
});

test('export: ok → заголовки onReady до первого байта, аудит один раз после завершения', async () => {
  let audited = 0;
  let ctypeAtReturn = null;
  const db = {
    enabled: true,
    async streamUserExport(_uid, res, { onReady }) {
      onReady();
      ctypeAtReturn = res.headers['Content-Type']; // заголовки стоят ещё до возврата исхода
      return 'ok';
    },
  };
  const { res, nextError } = await invokeExport(db, async () => { audited += 1; });
  assert.equal(nextError, null);
  assert.equal(ctypeAtReturn, 'application/json; charset=utf-8', 'Content-Type выставлен внутри onReady');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(res.headers['Content-Disposition'], /^attachment; filename="atlavue-export-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.jsonCalls, 0, 'на успехе роут не пишет json поверх стрима');
  assert.equal(audited, 1, 'аудит ровно один раз (account.exported)');
});

for (const outcome of ['aborted', 'stream_error']) {
  test(`export: ${outcome} → без второго ответа и без аудита`, async () => {
    let audited = 0;
    const db = {
      enabled: true,
      async streamUserExport(_uid, res, { onReady }) { onReady(); return outcome; },
    };
    const { res, nextError } = await invokeExport(db, async () => { audited += 1; });
    assert.equal(nextError, null);
    assert.equal(res.jsonCalls, 0, 'ответ уже завершён/уничтожен — второй раз не отвечаем');
    assert.equal(audited, 0, `${outcome} не аудитим`);
  });
}

test('export: throw ДО стрима → next(error)', async () => {
  const boom = new Error('early failure before first byte');
  const db = { enabled: true, async streamUserExport() { throw boom; } };
  const { res, nextError } = await invokeExport(db);
  assert.equal(nextError, boom, 'ошибка уходит в next(err) — штатный 500');
  assert.equal(res.jsonCalls, 0);
});

test('export: без БД → 503', async () => {
  const db = { enabled: false, async streamUserExport() { throw new Error('must not run without db'); } };
  const { res } = await invokeExport(db);
  assert.equal(res.statusCode, 503);
});
