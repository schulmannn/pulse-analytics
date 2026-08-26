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
      getCdekSummaryForActor: async () => ({ current: null, previous: null }),
      getCdekSeriesForActor: async () => ({ grain: 'day', current: [], previous: [] }),
      getCdekBreakdownForActor: async () => [],
      getCdekCoverageForActor: async () => [],
      getCdekBoundsForActor: async () => null,
      CDEK_BREAKDOWN_MAX_GROUPS: 2000,
      CDEK_COVERAGE_MAX_DAYS: 800,
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

// ── Чтение аналитики ──────────────────────────────────────────────────────────────────────────

const TOTALS = {
  revenue_kopecks: '307631932', orders: '1035', items: '1061',
  orders_all: '1095', orders_cancelled: '59', orders_returned: '1',
};

test('кривой диапазон — 400 до похода в базу', async () => {
  let touched = false;
  const { routes } = build({ db: { getCdekSummaryForActor: async () => { touched = true; return null; } } });
  const res = await call(routes, 'GET /api/cdek/summary', { query: { from: '2026-03-10', to: '2026-03-01' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Некорректный диапазон/);
  assert.equal(touched, false);
});

test('итоги: копейки переводятся в рубли, средний чек считает сервер', async () => {
  // Средний чек, посчитанный клиентом из округлённых рублей, разошёлся бы с выручкой и заказами,
  // которые показаны рядом на той же карточке.
  const { routes } = build({
    db: { getCdekSummaryForActor: async () => ({ current: TOTALS, previous: { ...TOTALS, revenue_kopecks: '200000000', orders: '800' } }) },
  });
  const res = await call(routes, 'GET /api/cdek/summary', { query: { from: '2025-07-31', to: '2026-07-30' } });
  assert.equal(res.body.current.revenue, 3076319.32);
  assert.equal(res.body.current.orders, 1035);
  assert.equal(res.body.current.avg_check, 3076319.32 / 1035);
  assert.equal(res.body.current.orders_cancelled, 59);
  assert.ok(Math.abs(res.body.current.cancel_share - 59 / 1095) < 1e-12);
  assert.equal(res.body.previous.orders, 800);
  assert.deepEqual(res.body.previous_window, { from: '2024-07-31', to: '2025-07-30' });
});

test('«Всё» не отдаёт выдуманного предыдущего окна ни в итогах, ни в ряду', async () => {
  const { routes } = build({
    db: {
      getCdekSummaryForActor: async () => ({ current: TOTALS, previous: TOTALS }),
      getCdekSeriesForActor: async () => ({
        grain: 'month',
        current: [{ day: '2026-03-01', revenue_kopecks: '100', orders: '1', items: '1' }],
        previous: [{ day: '2025-03-01', revenue_kopecks: '999', orders: '9', items: '9' }],
      }),
    },
  });
  const summary = await call(routes, 'GET /api/cdek/summary', { query: { days: '0' } });
  assert.equal(summary.body.window.all, true);
  assert.equal(summary.body.previous, null);
  assert.equal(summary.body.previous_window, null);

  const series = await call(routes, 'GET /api/cdek/series', { query: { days: '0' } });
  assert.equal(series.body.grain, 'month');
  assert.deepEqual(series.body.previous, [], 'сравнивать всю историю не с чем');
  assert.equal(series.body.current[0].revenue, 1);
});

test('разрез: хвост сворачивается в «Прочее», знаменатель остаётся честным', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    key: `p${i}`, revenue_kopecks: String((5 - i) * 10000), orders: '2', items: '2',
    prev_revenue_kopecks: '1000', prev_orders: '1',
  }));
  const { routes } = build({ db: { getCdekBreakdownForActor: async () => rows } });
  const res = await call(routes, 'GET /api/cdek/breakdown', { query: { dim: 'product', limit: '2' } });
  assert.equal(res.body.rows.length, 2);
  assert.equal(res.body.other.groups, 3);
  assert.equal(res.body.other.revenue, 300 + 200 + 100);
  assert.equal(res.body.total.revenue, 500 + 400 + 300 + 200 + 100, 'итог считает ВСЕ группы, а не показанные');
  assert.equal(res.body.truncated, false);
});

test('разрез по статусам смотрит на все заказы, а не только на «выручку»', async () => {
  // Отфильтруй мы отменённые как не-выручку, разбивка ПО статусам показала бы ровно те статусы,
  // которые сама и отобрала.
  let seen = null;
  const { routes } = build({
    db: { getCdekBreakdownForActor: async (_id, _actor, opts) => { seen = opts; return []; } },
  });
  await call(routes, 'GET /api/cdek/breakdown', { query: { dim: 'status', include: 'completed' } });
  assert.equal(seen.include, 'all');
  await call(routes, 'GET /api/cdek/breakdown', { query: { dim: 'channel', include: 'completed' } });
  assert.equal(seen.include, 'completed', 'остальные измерения режим уважают');
});

test('пустой ключ разреза отдаётся как null — это отсутствие канала, а не его имя', async () => {
  const { routes } = build({
    db: {
      getCdekBreakdownForActor: async () => [
        { key: '', revenue_kopecks: '100', orders: '1', items: '1', prev_revenue_kopecks: '0', prev_orders: '0' },
      ],
    },
  });
  const res = await call(routes, 'GET /api/cdek/breakdown', { query: {} });
  assert.equal(res.body.rows[0].key, null);
});

test('календарь покрытия при «Всё» берёт размах архива, а не выдумывает окно', async () => {
  let seen = null;
  const { routes } = build({
    db: {
      getCdekBoundsForActor: async () => ({ first_day: '2025-07-31', last_day: '2026-07-30', orders: 1100 }),
      getCdekCoverageForActor: async (_id, _actor, opts) => {
        seen = opts;
        return [{ day: '2025-07-31', revenue_kopecks: '100000', orders: '1', covered: true }];
      },
    },
  });
  const res = await call(routes, 'GET /api/cdek/coverage', { query: { days: '0' } });
  assert.deepEqual([seen.from, seen.to], ['2025-07-31', '2026-07-30']);
  assert.equal(res.body.days[0].revenue, 1000);
  assert.equal(res.body.days[0].covered, true);
});

test('пустой архив: календарь отвечает пусто, а не пятисоткой', async () => {
  const { routes } = build({ db: { getCdekBoundsForActor: async () => null } });
  const res = await call(routes, 'GET /api/cdek/coverage', { query: { days: '0' } });
  assert.deepEqual(res.body, { from: null, to: null, days: [], bounds: null });
});

test('чтение доступно роли viewer — под admin только запись', async () => {
  const { routes } = build({
    db: {
      getChannelOrDefault: async () => ({ id: 5, owner_uid: 42, source: 'cdek', member_role: 'viewer' }),
      getCdekSummaryForActor: async () => ({ current: TOTALS, previous: null }),
    },
  });
  const res = await call(routes, 'GET /api/cdek/summary', { query: { days: '30' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.current.orders, 1035);
});

/**
 * Регресс прод-бага: выбор канала продаж в ленте заказов отвечал «Не удалось получить заказы».
 *
 * Фильтр ходил параметром `?channel=yandex_market`, а тем же именем сервер разбирает канал
 * АРЕНДАТОРА: `parseInt('yandex_market')` → NaN → `|| 0` → «канал по умолчанию». У владельца
 * дефолтным был не СДЭК, поэтому запрос отбивался 404 «Это не источник СДЭК».
 *
 * Ни один прежний тест этого не ловил: интеграционный звал репозиторий НАПРЯМУЮ (там фильтр
 * работал), а роут-стаб отдавал СДЭК-канал на любой id и подмену арендатора прятал. Поэтому
 * заглушка здесь ЧЕСТНАЯ — id решает, какой канал вернётся.
 */
function ordersBuild(seen) {
  return build({
    db: {
      getChannelOrDefault: async (id) => (
        id === 5
          ? { id: 5, owner_uid: 7, source: 'cdek', title: 'Склад', member_role: 'owner' }
          // id 0 — «канал по умолчанию»: у владельца это Telegram, а не СДЭК.
          : id === 0 ? { id: 1, owner_uid: 7, source: 'tg', title: 'Канал', member_role: 'owner' } : null
      ),
      getCdekOrdersForActor: async (channelId, _actor, opts) => {
        seen.push({ channelId, channel: opts.channel, status: opts.status });
        return { rows: [], total: 0 };
      },
    },
  });
}

test('фильтр по каналу продаж не подменяет канал арендатора', async () => {
  const seen = [];
  const { routes } = ordersBuild(seen);
  const res = await call(routes, 'GET /api/cdek/orders', {
    query: { sales_channel: 'yandex_market', status: 'complete' },
    headers: { 'x-channel-id': '5' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ channelId: 5, channel: 'yandex_market', status: 'complete' }]);
});

test('вкладка, открытая до выката, шлёт старое имя — фильтр всё равно доезжает', async () => {
  const seen = [];
  const { routes } = ordersBuild(seen);
  const res = await call(routes, 'GET /api/cdek/orders', {
    query: { channel: 'yandex_market' },
    headers: { 'x-channel-id': '5' },
  });
  assert.equal(res.status, 200);
  assert.equal(seen[0].channelId, 5, 'арендатор берётся из заголовка, а не из мусорного ?channel');
  assert.equal(seen[0].channel, 'yandex_market', 'а само значение работает фильтром');
});

test('числовой ?channel по-прежнему выбирает канал арендатора', async () => {
  // Этим путём ходят прямые ссылки на скачивание CSV — заголовок в <a href> не поставить.
  const seen = [];
  const { routes } = ordersBuild(seen);
  const res = await call(routes, 'GET /api/cdek/orders', {
    query: { channel: '5' },
    headers: { 'x-channel-id': '9' },
  });
  assert.equal(res.status, 200);
  assert.equal(seen[0].channelId, 5);
  assert.equal(seen[0].channel, undefined, 'числовое значение фильтром НЕ становится');
});

test('перебор потолка товаров — честный отказ, а не срезанный хвост', async () => {
  // Раньше 51-й товар просто исчезал: выручка считалась по пятидесяти, а карточка над ней писала
  // «Только выбранные товары: 51». Ответ применённый список не возвращает, узнать о подмене
  // неоткуда. Тот же вопрос в МойСкладе решён отказом — здесь теперь так же.
  let reached = false;
  const { routes } = build({ db: { getCdekSummaryForActor: async () => { reached = true; return { current: null, previous: null }; } } });
  const products = Array.from({ length: 51 }, (_, i) => `p${String(i + 1).padStart(3, '0')}`).join(',');
  const res = await call(routes, 'GET /api/cdek/summary', { query: { days: '30', products } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /не более 50 товаров/i);
  assert.equal(reached, false, 'до репозитория запрос доходить не должен');
});

test('набор ровно по потолку проходит целиком', async () => {
  const seen = [];
  const { routes } = build({
    db: { getCdekSummaryForActor: async (_id, _actor, opts) => { seen.push(opts.products); return { current: null, previous: null }; } },
  });
  const list = Array.from({ length: 50 }, (_, i) => `p${String(i + 1).padStart(3, '0')}`);
  const res = await call(routes, 'GET /api/cdek/summary', { query: { days: '30', products: list.join(',') } });
  assert.equal(res.status, 200);
  assert.equal(seen[0].length, 50);
});

test('незнакомый канал продаж — отказ, а не пустой график', async () => {
  // «Wildberrys» с опечаткой молча дал бы ноль строк, неотличимый от «продаж не было».
  let reached = false;
  const { routes } = build({ db: { getCdekSummaryForActor: async () => { reached = true; return { current: null, previous: null }; } } });
  const res = await call(routes, 'GET /api/cdek/summary', { query: { days: '30', sales_channels: 'wildberrys' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /канал продаж/i);
  assert.equal(reached, false);
});

test('известные каналы доезжают до репозитория набором', async () => {
  const seen = [];
  const { routes } = build({
    db: { getCdekSeriesForActor: async (_id, _actor, opts) => { seen.push(opts.channels); return { grain: 'day', current: [], previous: [] }; } },
  });
  const res = await call(routes, 'GET /api/cdek/series', { query: { days: '30', sales_channels: 'ozon,own' } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen[0], ['own', 'ozon'], 'набор нормализован и отсортирован');
});

test('выбраны все каналы — это «фильтра нет», а не длинный список', async () => {
  const seen = [];
  const { routes } = build({
    db: { getCdekSeriesForActor: async (_id, _actor, opts) => { seen.push(opts.channels); return { grain: 'day', current: [], previous: [] }; } },
  });
  await call(routes, 'GET /api/cdek/series', {
    query: { days: '30', sales_channels: 'other,own,ozon,wildberries,yandex_market' },
  });
  assert.equal(seen[0], null, 'полный набор сворачивается в null — короче строка, устойчивее кэш');
});
