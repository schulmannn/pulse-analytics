'use strict';

// Route-тесты /api/ms/stock («что заканчивается») — fake-app паттерн ms_analytics_routes.test.js:
// auth — pass-middleware, db/msFetch/msCrypto — стабы, кэш — реальный memoryCache (без start()).
// Фокус:
//   • happy-path — живой отчёт остатков (страницы по 1000) + скорость продаж из raw-отчёта
//     profit/byproduct: матч по id (хвост meta.href), фолбэк по имени, математика days_left,
//     сорт days_left ASC NULLS LAST → stock ASC;
//   • продажи = 0 → days_left null («нет продаж»), не выдуманная бесконечность;
//   • отозванный токен (401/403 от МС) → 401 + code ms_token_revoked;
//   • кэш-хит вторым вызовом (без повторных живых вызовов) и общий raw-кэш с top-products
//     (второго page-loop продаж нет);
//   • «Всё» (days=0 без диапазона) → честный 400 ДО единого живого вызова;
//   • кламп ответа 200 строками.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerMsRoutes } = require('../server/routes/moysklad');
const { createMemoryCache } = require('../server/infrastructure/memoryCache');

function buildMs({ msFetch, db = {} } = {}) {
  const routes = new Map();
  const app = {
    get(path, ...h) { routes.set(`GET ${path}`, h); },
    post(path, ...h) { routes.set(`POST ${path}`, h); },
    put(path, ...h) { routes.set(`PUT ${path}`, h); },
    delete(path, ...h) { routes.set(`DELETE ${path}`, h); },
  };
  const pass = (_req, _res, next) => next();
  const cache = createMemoryCache({});
  const sleeps = [];
  registerMsRoutes({
    app,
    requireAuth: pass,
    db: {
      enabled: true,
      getChannelOrDefault: async () => ({ id: 5, owner_uid: 7 }),
      getMsAccount: async () => ({ access_token_enc: 'enc', org_name: 'ООО Ромашка', ms_account_id: 'acc-1' }),
      ...db,
    },
    audit: async () => {},
    msCrypto: { configured: () => true, decrypt: (enc) => `TOKEN:${enc}`, encrypt: (t) => `enc(${t})` },
    msFetch,
    msBackfill: { isBusy: async () => false, start: () => Promise.resolve({}) },
    cacheGet: cache.get,
    cacheSet: cache.set,
    cache,
    log: () => {},
    sleepFn: async (ms) => { sleeps.push(ms); },
  });
  return { routes, sleeps };
}

async function invoke(routes, key, { query = {}, headers = {}, body = {} } = {}) {
  const handler = routes.get(key).at(-1);
  const res = {
    statusCode: 200,
    headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let nextError = null;
  await handler({ query, headers, body, user: { uid: 7 } }, res, (e) => { nextError = e; });
  if (nextError) throw nextError;
  return res;
}

// Строка отчёта остатков МС: meta.href несёт id товара хвостом (query-хвост должен отрезаться).
const stockRow = (id, name, stock, reserve) => ({
  ...(id ? { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/product/${id}?expand=x` } } : {}),
  name,
  stock,
  reserve,
  inTransit: 0,
  quantity: stock + reserve,
});

// Строка отчёта profit/byproduct (продажи окна).
const profitRow = (id, name, sellQuantity) => ({
  assortment: id
    ? { name, meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/product/${id}` } }
    : { name },
  sellQuantity,
  sellSum: 100_00,
  profit: 10_00,
});

// Стаб msFetch, различающий отчёт остатков и продаж; считает вызовы по видам.
function stockAndSalesFetch({ stockRows, profitRows }) {
  const calls = { stock: [], profit: [] };
  const fetch = async (token, path) => {
    assert.equal(token, 'TOKEN:enc');
    if (path.startsWith('/report/stock/all?')) {
      calls.stock.push(path);
      const q = new URLSearchParams(path.split('?')[1] || '');
      assert.equal(q.get('limit'), '1000', 'страница отчёта остатков — максимум API');
      const offset = Number(q.get('offset')) || 0;
      return { rows: stockRows.slice(offset, offset + 1000) };
    }
    if (path.startsWith('/report/profit/byproduct?')) {
      calls.profit.push(path);
      return { rows: profitRows, meta: { size: profitRows.length } };
    }
    throw new Error(`неожиданный path: ${path}`);
  };
  return { fetch, calls };
}

test('stock: матч продаж по id и фолбэк по имени; days_left = stock ÷ (продано/дней); сорт ASC NULLS LAST → stock ASC', async () => {
  const { fetch, calls } = stockAndSalesFetch({
    stockRows: [
      stockRow('aaa', 'Свеча', 10, 2),
      stockRow('bbb', 'Диффузор', 100, 0),
      stockRow(null, 'Без href', 5, 0),          // нет meta → id null → фолбэк по имени
      stockRow('ddd', 'Мертвяк', 50, 1),         // продаж нет → days_left null (хвост)
    ],
    profitRows: [
      profitRow('aaa', 'Свеча', 30),             // 1/день → 10 остатка = 10 дн.
      profitRow('bbb', 'Диффузор', 15),          // 0.5/день → 100 остатка = 200 дн.
      profitRow(null, 'Без href', 60),           // 2/день → 5 остатка = 2.5 дн. (матч по имени)
    ],
  });
  const { routes } = buildMs({ msFetch: fetch });
  const res = await invoke(routes, 'GET /api/ms/stock', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    window_days: 30,
    rows: [
      { id: null, name: 'Без href', stock: 5, reserve: 0, days_left: 2.5, sold_window: 60 },
      { id: 'aaa', name: 'Свеча', stock: 10, reserve: 2, days_left: 10, sold_window: 30 },
      { id: 'bbb', name: 'Диффузор', stock: 100, reserve: 0, days_left: 200, sold_window: 15 },
      { id: 'ddd', name: 'Мертвяк', stock: 50, reserve: 1, days_left: null, sold_window: 0 },
    ],
  });
  assert.equal(calls.stock.length, 1, 'остатки в одну страницу');
  assert.equal(calls.profit.length, 1, 'продажи — один page-loop');
});

test('stock: без продаж за окно — у всех days_left null, порядок по stock ASC', async () => {
  const { fetch } = stockAndSalesFetch({
    stockRows: [stockRow('a', 'А', 30, 0), stockRow('b', 'Б', 5, 0)],
    profitRows: [],
  });
  const { routes } = buildMs({ msFetch: fetch });
  const res = await invoke(routes, 'GET /api/ms/stock', { query: { days: '7' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows, [
    { id: 'b', name: 'Б', stock: 5, reserve: 0, days_left: null, sold_window: 0 },
    { id: 'a', name: 'А', stock: 30, reserve: 0, days_left: null, sold_window: 0 },
  ]);
});

test('stock: 401/403 от МС → 401 + ms_token_revoked (reconnect-CTA, не «сервис упал»)', async () => {
  const { routes } = buildMs({
    msFetch: async () => {
      const e = new Error('МойСклад: HTTP 401');
      e.status = 401;
      throw e;
    },
  });
  const res = await invoke(routes, 'GET /api/ms/stock', { query: { days: '30' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'ms_token_revoked');
});

test('stock: повторный запрос — из кэша ответа; raw-отчёт продаж ОБЩИЙ с top-products (без второго page-loop)', async () => {
  const { fetch, calls } = stockAndSalesFetch({
    stockRows: [stockRow('aaa', 'Свеча', 10, 0)],
    profitRows: [profitRow('aaa', 'Свеча', 30)],
  });
  const { routes } = buildMs({ msFetch: fetch });

  // top-products первым оплачивает page-loop продаж окна…
  const top = await invoke(routes, 'GET /api/ms/top-products', { query: { days: '30' } });
  assert.equal(top.statusCode, 200);
  assert.equal(calls.profit.length, 1);

  // …stock тем же окном добавляет ТОЛЬКО живой отчёт остатков.
  const first = await invoke(routes, 'GET /api/ms/stock', { query: { days: '30' } });
  assert.equal(first.statusCode, 200);
  assert.equal(calls.profit.length, 1, 'скорость продаж читается из общего raw-кэша');
  assert.equal(calls.stock.length, 1);

  // Второй запрос stock — целиком из кэша ответа.
  const second = await invoke(routes, 'GET /api/ms/stock', { query: { days: '30' } });
  assert.deepEqual(second.body, first.body);
  assert.equal(calls.stock.length, 1, 'повторный ответ — из кэша, без живых вызовов');
  assert.equal(calls.profit.length, 1);
});

test('stock: «Всё» (days=0 без диапазона) → 400 ДО живых вызовов; конечный произвольный диапазон допустим', async () => {
  const { fetch, calls } = stockAndSalesFetch({
    stockRows: [stockRow('aaa', 'Свеча', 10, 0)],
    profitRows: [profitRow('aaa', 'Свеча', 14)],
  });
  const { routes } = buildMs({ msFetch: fetch });

  const all = await invoke(routes, 'GET /api/ms/stock', { query: { days: '0' } });
  assert.equal(all.statusCode, 400, 'окно обязано быть конечным');
  assert.equal(calls.stock.length + calls.profit.length, 0, 'ни одного живого вызова');

  // Кривой диапазон — тот же честный 400 разбора периода.
  const bad = await invoke(routes, 'GET /api/ms/stock', { query: { from: '2026-07-18', to: '2026-07-01' } });
  assert.equal(bad.statusCode, 400);

  // Конечный диапазон работает; знаменатель — фактическая инклюзивная длина окна (14 дней).
  const ranged = await invoke(routes, 'GET /api/ms/stock', {
    query: { days: '0', from: '2026-07-05', to: '2026-07-18' },
  });
  assert.equal(ranged.statusCode, 200);
  assert.equal(ranged.body.window_days, 14);
  assert.deepEqual(ranged.body.rows, [
    { id: 'aaa', name: 'Свеча', stock: 10, reserve: 0, days_left: 10, sold_window: 14 },
  ]);
});

test('stock: наружу уходят первые 200 строк по срочности', async () => {
  const many = Array.from({ length: 260 }, (_, i) =>
    stockRow(`p-${i}`, `Товар ${i}`, i + 1, 0));
  const { fetch } = stockAndSalesFetch({
    stockRows: many,
    // Продажи по 1 шт/окно у каждого → days_left = stock/ (1/30) = 30·stock: срочность растёт с i.
    profitRows: many.map((_, i) => profitRow(`p-${i}`, `Товар ${i}`, 1)),
  });
  const { routes } = buildMs({ msFetch: fetch });
  const res = await invoke(routes, 'GET /api/ms/stock', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rows.length, 200, 'кламп 200 строк');
  assert.equal(res.body.rows[0].name, 'Товар 0', 'первые — самые срочные (наименьший days_left)');
  assert.equal(res.body.rows[199].name, 'Товар 199');
});
