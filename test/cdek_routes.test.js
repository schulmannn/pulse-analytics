'use strict';

// Route-тесты /api/cdek/* (fake-app паттерн ms_stock_route.test.js): auth и raw-парсер — пропуски,
// db и сервис импорта — стабы. Фокус на границах, которых нет ниже по стеку: чужой канал, роль в
// воркспейсе, пустое тело, разница между «дубль» и «ошибка», экранирование выгружаемого CSV.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerCdekRoutes } = require('../server/routes/cdek');

function build({ db = {}, cdekImport = {} } = {}) {
  const routes = new Map();
  const app = {
    get(path, ...h) { routes.set(`GET ${path}`, h); },
    post(path, ...h) { routes.set(`POST ${path}`, h); },
  };
  const audits = [];
  registerCdekRoutes({
    app,
    express: { raw: () => (_req, _res, next) => next() },
    requireAuth: (_req, _res, next) => next(),
    db: {
      enabled: true,
      getChannelOrDefault: async () => ({ id: 5, owner_uid: 7, source: 'cdek', title: 'СДЭК', member_role: 'owner' }),
      getCdekSource: async () => ({ channel_id: 5, warehouse_code: '19821', tz: 'Europe/Moscow' }),
      listCdekImports: async () => [],
      getCdekImport: async () => null,
      createCdekChannel: async ({ name }) => ({ id: 12, title: name }),
      saveCdekSource: async () => true,
      ...db,
    },
    audit: async (_req, event, meta) => { audits.push({ event, meta }); },
    cdekImport: {
      importFile: async () => ({ duplicate: false, import: { id: 1, rows_total: 3 } }),
      replayImport: async () => ({ import: { id: 1 } }),
      ...cdekImport,
    },
  });
  return { routes, audits };
}

async function call(routes, key, req = {}) {
  const handlers = routes.get(key);
  assert.ok(handlers, `нет роута ${key}`);
  const out = { status: 200, body: null, headers: {}, sent: null };
  const res = {
    status(code) { out.status = code; return res; },
    json(body) { out.body = body; return res; },
    send(body) { out.sent = body; return res; },
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
  };
  const request = { query: {}, headers: {}, params: {}, body: undefined, user: { uid: 7 }, ...req };
  let failure = null;
  await handlers[handlers.length - 1](request, res, (e) => { failure = e; });
  if (failure) throw failure;
  return out;
}

const FILE = Buffer.from('PKфиктивные байты файла');

test('создание источника: канал, каноническая привязка и аудит', async () => {
  const { routes, audits } = build();
  const res = await call(routes, 'POST /api/cdek/sources', { body: { name: 'Склад СДЭК', tz: 'Asia/Yekaterinburg' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.channel_id, 12);
  assert.equal(res.body.tz, 'Asia/Yekaterinburg');
  assert.equal(audits[0].event, 'cdek_source_create');
});

test('несуществующий часовой пояс отбивается ДО создания канала', async () => {
  // Иначе AT TIME ZONE упал бы внутри транзакции импорта, и пользователь увидел бы пятисотку
  // вместо понятной причины.
  let created = false;
  const { routes } = build({ db: { createCdekChannel: async () => { created = true; return { id: 1 }; } } });
  const res = await call(routes, 'POST /api/cdek/sources', { body: { name: 'X', tz: 'Марс/Олимп' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /часовой пояс/i);
  assert.equal(created, false);
});

test('загрузка в канал другого источника — 404, а не запись мимо', async () => {
  const { routes } = build({
    db: { getChannelOrDefault: async () => ({ id: 5, owner_uid: 7, source: 'ms', member_role: 'owner' }) },
  });
  const res = await call(routes, 'POST /api/cdek/import', { body: FILE });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /не источник СДЭК/i);
});

test('чужой канал — 403 по явному ?channel=', async () => {
  const { routes } = build({ db: { getChannelOrDefault: async () => null } });
  const res = await call(routes, 'POST /api/cdek/import', { query: { channel: '99' }, body: FILE });
  assert.equal(res.status, 403);
});

test('импорт требует роли admin: member переписать общий архив не может', async () => {
  const { routes } = build({
    db: {
      getChannelOrDefault: async () => ({ id: 5, owner_uid: 42, source: 'cdek', member_role: 'member' }),
    },
  });
  const res = await call(routes, 'POST /api/cdek/import', { body: FILE });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /Недостаточно прав/);
});

test('пустое тело — 400 до вызова сервиса', async () => {
  let called = false;
  const { routes } = build({ cdekImport: { importFile: async () => { called = true; } } });
  const res = await call(routes, 'POST /api/cdek/import', { body: Buffer.alloc(0) });
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('успешная загрузка отдаёт отчёт и пишет аудит', async () => {
  const { routes, audits } = build();
  const res = await call(routes, 'POST /api/cdek/import', {
    body: FILE, headers: { 'x-filename': 'orders_export.xlsx' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, false);
  assert.equal(res.body.import.rows_total, 3);
  assert.equal(audits[0].event, 'cdek_import');
  assert.equal(audits[0].meta.filename, 'orders_export.xlsx');
});

test('повторная загрузка того же файла — 200 с прежним отчётом, не ошибка', async () => {
  const { routes, audits } = build({
    cdekImport: { importFile: async () => ({ duplicate: true, import: { id: 41, created_at: '2026-01-12T09:00:00' } }) },
  });
  const res = await call(routes, 'POST /api/cdek/import', { body: FILE });
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.import.id, 41);
  assert.equal(audits.length, 0, 'повтор не порождает второго события аудита');
});

test('нечитаемый файл — 422 с человеческим текстом, а не 500', async () => {
  const { routes } = build({
    cdekImport: {
      importFile: async () => {
        throw Object.assign(new Error('boom'), { userMessage: 'Это не .xlsx — внутри нет zip-архива' });
      },
    },
  });
  const res = await call(routes, 'POST /api/cdek/import', { body: FILE });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /не \.xlsx/);
});

test('внутренняя ошибка сервиса уходит в общий обработчик, а не притворяется 422', async () => {
  const { routes } = build({
    cdekImport: { importFile: async () => { throw new Error('соединение с БД потеряно'); } },
  });
  await assert.rejects(() => call(routes, 'POST /api/cdek/import', { body: FILE }), /соединение с БД потеряно/);
});

test('выгрузка отвергнутых строк: BOM, разделитель и защита от формул', async () => {
  const { routes } = build({
    db: {
      getCdekImport: async () => ({
        id: 7,
        rejected: [
          { row: 12, order_id: '33896248', reason: 'нет товара' },
          { row: 13, order_id: '=cmd|calc', reason: 'нет номера заказа' },
        ],
      }),
    },
  });
  const res = await call(routes, 'GET /api/cdek/imports/:id/rejected.csv', { params: { id: '7' } });
  assert.match(res.headers['content-type'], /text\/csv; charset=utf-8/);
  assert.match(res.headers['content-disposition'], /cdek-rejected-7\.csv/);
  assert.ok(res.sent.startsWith('﻿'), 'без BOM Excel прочитает utf-8 как windows-1251');
  assert.match(res.sent, /"12";"33896248";"нет товара"/);
  assert.match(res.sent, /"'=cmd\|calc"/, 'формула обезврежена апострофом');
});

test('статус источника показывает склад, зону и последний импорт', async () => {
  const { routes } = build({
    db: { listCdekImports: async () => [{ id: 9, rows_total: 1126, period_to: '2026-07-30' }] },
  });
  const res = await call(routes, 'GET /api/cdek/status');
  assert.equal(res.body.warehouse_code, '19821');
  assert.equal(res.body.tz, 'Europe/Moscow');
  assert.equal(res.body.last_import.rows_total, 1126);
});

test('переигровка тоже под ролью admin', async () => {
  const { routes } = build({
    db: { getChannelOrDefault: async () => ({ id: 5, owner_uid: 42, source: 'cdek', member_role: 'viewer' }) },
  });
  const res = await call(routes, 'POST /api/cdek/imports/:id/replay', { params: { id: '7' } });
  assert.equal(res.status, 403);
});
