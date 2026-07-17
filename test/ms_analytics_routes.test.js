'use strict';

// Route-тесты слайсов 3–4 МойСклада (fake-app паттерн reports_route/campaigns_route): auth —
// pass-middleware, db/msFetch/msCrypto — стабы, кэш — реальный memoryCache (без start(), таймеров
// нет), пауза page-loop'а — записывающий sleepFn (как в тестах движка бэкфилла). Фокус:
//   • /api/ms/returns — живой page-loop (окно-фильтр целиком URL-encoded, страницы limit/offset,
//     cap → truncated, копейки → рубли на границе, кэш-хит вторым вызовом, ms_token_revoked);
//   • /api/ms/funnel — словарь статусов (int-цвет → '#rrggbb', NULL-строка → no_state_orders,
//     мягкая деградация без словаря, неуспех словаря не кэшируется);
//   • /api/ms/top-products days=0 — честное «Всё» (якорь от старейшего заказа архива, фолбэк
//     '2020-01-01' на пустом архиве, кэш-ключ различает 0 и 30);
//   • /api/ms/top-customers — DB-агрегат + имена ОДНИМ OR-вызовом словаря контрагентов
//     (деградация → name:null без кэша, 401/403 → ms_token_revoked, кэш-хит);
//   • /api/ms/sales-by-channel — DB-агрегат + словарь saleschannel (name/type, NULL-канал →
//     no_channel_orders, мягкая деградация без кэша, 401/403 → ms_token_revoked, кэш-хит словаря);
//   • /api/ms/geography — чистый DB-агрегат (нормализация города — в SQL, здесь только проброс
//     total/no_city и копейки→рубли, без словаря и кэша);
//   • connect/disconnect — audit-события ms_connect/ms_disconnect без токена в metadata.

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
  const audits = [];
  registerMsRoutes({
    app,
    requireAuth: pass,
    db: {
      enabled: true,
      getChannelOrDefault: async () => ({ id: 5, owner_uid: 7 }),
      getMsAccount: async () => ({ access_token_enc: 'enc', org_name: 'ООО Ромашка', ms_account_id: 'acc-1' }),
      ...db,
    },
    audit: async (_req, action, meta) => { audits.push({ action, meta }); },
    msCrypto: { configured: () => true, decrypt: (enc) => `TOKEN:${enc}`, encrypt: (t) => `enc(${t})` },
    msFetch,
    msBackfill: { isBusy: async () => false, start: () => Promise.resolve({}) },
    cacheGet: cache.get,
    cacheSet: cache.set,
    cache,
    log: () => {},
    sleepFn: async (ms) => { sleeps.push(ms); },
  });
  return { routes, sleeps, audits };
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

const ret = (sum) => ({ sum });

test('returns: окно-фильтр encoded как у движка, страницы суммируются в копейках, наружу рубли', async () => {
  const fetches = [];
  const fullPage = Array.from({ length: 1000 }, () => ret(100));
  const { routes, sleeps } = buildMs({
    msFetch: async (token, path) => {
      assert.equal(token, 'TOKEN:enc');
      assert.ok(!path.includes(' '), `path обязан быть URL-encoded (пробел в: ${path})`);
      fetches.push(path);
      const q = new URLSearchParams(path.split('?')[1] || '');
      assert.match(q.get('filter'), /^moment>=\d{4}-\d{2}-\d{2} 00:00:00;moment<=\d{4}-\d{2}-\d{2} 23:59:59$/);
      assert.equal(q.get('limit'), '1000');
      assert.equal(q.get('order'), 'moment,asc');
      return Number(q.get('offset')) === 0 ? { rows: fullPage } : { rows: [ret(250.4), ret(50)] };
    },
  });
  const res = await invoke(routes, 'GET /api/ms/returns', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  // 1000×100 + 250 + 50 = 100 300 копеек = 1003 ₽ (одна конверсия на границе).
  assert.deepEqual(res.body, { window_days: 30, count: 1002, sum: 1003, truncated: false });
  assert.equal(fetches.length, 2);
  assert.deepEqual(sleeps, [150], 'пауза ровно между страницами (после последней не спим)');
});

test('returns: cap 5 страниц → truncated, дальше МС не дёргаем', async () => {
  let n = 0;
  const fullPage = Array.from({ length: 1000 }, () => ret(10));
  const { routes, sleeps } = buildMs({ msFetch: async () => { n += 1; return { rows: fullPage }; } });
  const res = await invoke(routes, 'GET /api/ms/returns', { query: { days: '7' } });
  assert.deepEqual(res.body, { window_days: 7, count: 5000, sum: 500, truncated: true });
  assert.equal(n, 5, 'ровно cap страниц');
  assert.deepEqual(sleeps, [150, 150, 150, 150]);
});

test('returns: days=0 — вся история БЕЗ фильтра; повторный вызов — кэш-хит без запросов к МС', async () => {
  const fetches = [];
  const { routes } = buildMs({
    msFetch: async (_token, path) => {
      fetches.push(path);
      assert.ok(!path.includes('filter='), 'days=0 живёт без фильтра окна');
      return { rows: [ret(1234)] };
    },
  });
  const first = await invoke(routes, 'GET /api/ms/returns', { query: { days: '0' } });
  assert.deepEqual(first.body, { window_days: 0, count: 1, sum: 12.34, truncated: false });
  assert.equal(fetches.length, 1);
  const second = await invoke(routes, 'GET /api/ms/returns', { query: { days: '0' } });
  assert.deepEqual(second.body, first.body);
  assert.equal(fetches.length, 1, 'второй ответ — из кэша (10 минут)');
});

test('returns: 401/403 от МС → 401 ms_token_revoked (reconnect-CTA, как остальные data-роуты)', async () => {
  const { routes } = buildMs({
    msFetch: async () => {
      const e = new Error('МойСклад: HTTP 401');
      e.status = 401;
      throw e;
    },
  });
  const res = await invoke(routes, 'GET /api/ms/returns', { query: { days: '30' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'ms_token_revoked');
});

test('funnel: словарь статусов мапит имя и int-цвет → #rrggbb, NULL-строка → no_state_orders, словарь кэшируется', async () => {
  const metaPaths = [];
  const { routes } = buildMs({
    msFetch: async (_token, path) => {
      metaPaths.push(path);
      assert.equal(path, '/entity/customerorder/metadata');
      // color — живой int RGB МойСклада: 8825440 = 0x86aa60.
      return { states: [{ id: 's1', name: 'Оплачен', color: 8825440, stateType: 'Regular' }] };
    },
    db: {
      getMsFunnelForActor: async (channelId, actor, opts) => {
        assert.equal(channelId, 5);
        assert.equal(actor.uid, 7);
        assert.match(opts.sinceDay, /^\d{4}-\d{2}-\d{2}$/, 'days>0 → нижняя граница окна');
        return [
          { state_id: 's1', orders: 4, sum_kopecks: 5600 },
          { state_id: 's-gone', orders: 3, sum_kopecks: 300 },   // снятый статус — в словаре нет
          { state_id: null, orders: 2, sum_kopecks: 750 },
        ];
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/funnel', { query: { days: '90' } });
  assert.deepEqual(res.body, {
    window_days: 90,
    total_orders: 9,
    no_state_orders: 2,
    rows: [
      { state_id: 's1', name: 'Оплачен', color: '#86aa60', orders: 4, sum: 56 },
      { state_id: 's-gone', name: null, color: null, orders: 3, sum: 3 },
    ],
  });
  await invoke(routes, 'GET /api/ms/funnel', { query: { days: '90' } });
  assert.equal(metaPaths.length, 1, 'второй запрос берёт словарь из кэша (1 час)');
});

test('funnel: недоступный словарь деградирует мягко (name/color null) и НЕ кэшируется; days=0 → вся история', async () => {
  let metaCalls = 0;
  let seenSince = 'UNSET';
  const { routes } = buildMs({
    msFetch: async () => {
      metaCalls += 1;
      const e = new Error('МойСклад: HTTP 500');
      e.status = 500;
      throw e;
    },
    db: {
      getMsFunnelForActor: async (_channelId, _actor, opts) => {
        seenSince = opts.sinceDay;
        return [{ state_id: 's1', orders: 1, sum_kopecks: 100 }];
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/funnel', { query: { days: '0' } });
  assert.equal(res.statusCode, 200, 'DB-агрегат не заложник живого МС');
  assert.deepEqual(res.body.rows, [{ state_id: 's1', name: null, color: null, orders: 1, sum: 1 }]);
  assert.equal(seenSince, null, 'days=0 = вся история (sinceDay null)');
  await invoke(routes, 'GET /api/ms/funnel', { query: { days: '0' } });
  assert.equal(metaCalls, 2, 'неуспех словаря не кэшируется — следующий запрос пробует снова');
});

test('top-products: окно добирается страницами, топ сортируется по выручке у нас (МС отдаёт алфавит)', async () => {
  const fetches = [];
  // Страница 1 — ровно 1000 «алфавитных» строк с малой выручкой; настоящие хиты — на 2-й странице.
  const fullPage = Array.from({ length: 1000 }, (_, i) => ({
    assortment: { name: `А-товар ${String(i).padStart(4, '0')}` },
    sellQuantity: 1,
    sellSum: 100_00,
    profit: 10_00,
  }));
  const { routes, sleeps } = buildMs({
    msFetch: async (_token, path) => {
      fetches.push(path);
      const q = new URLSearchParams(path.split('?')[1] || '');
      assert.equal(q.get('limit'), '1000', 'страница отчёта — максимум API, не пользовательский limit');
      return Number(q.get('offset')) === 0
        ? { rows: fullPage, meta: { size: 1002 } }
        : {
            rows: [
              { assortment: { name: 'Я-хит' }, sellQuantity: 5, sellSum: 999_00, profit: 500_00 },
              { assortment: { name: 'Я-середина' }, sellQuantity: 2, sellSum: 300_00, profit: 50_00 },
            ],
          };
    },
  });
  const res = await invoke(routes, 'GET /api/ms/top-products', { query: { days: '30', limit: '2' } });
  assert.equal(res.statusCode, 200);
  assert.equal(fetches.length, 2, 'вторая страница добрана');
  assert.equal(sleeps.length, 1, 'пауза между страницами — щадим лимит 45/3с');
  assert.deepEqual(
    res.body.rows.map((r) => r.name),
    ['Я-хит', 'Я-середина'],
    'первые строки — по выручке, а не первые по алфавиту',
  );
  assert.equal(res.body.rows[0].revenue, 999, 'копейки → рубли на границе');
  assert.equal(res.body.total, 1002, 'total — meta.size первой страницы');
  assert.equal(res.body.truncated, false);
  // Кэш-хит вторым вызовом: upstream больше не дёргается.
  await invoke(routes, 'GET /api/ms/top-products', { query: { days: '30', limit: '2' } });
  assert.equal(fetches.length, 2, 'повторный запрос отвечает из кэша');
});

test('top-products: days=0 — окно от первого дня месяца старейшего заказа архива; кэш-ключ различает 0 и 30', async () => {
  const windows = [];
  const oldestCalls = [];
  const { routes } = buildMs({
    msFetch: async (_token, path) => {
      const q = new URLSearchParams(path.split('?')[1] || '');
      windows.push({ from: q.get('momentFrom'), to: q.get('momentTo') });
      return { rows: [{ assortment: { name: 'Товар' }, sellQuantity: 1, sellSum: 100_00, profit: 10_00 }], meta: { size: 1 } };
    },
    db: {
      getMsOldestOrderDayForActor: async (channelId, actor) => {
        oldestCalls.push(channelId);
        assert.equal(channelId, 5);
        assert.equal(actor.uid, 7);
        return '2023-05-17';
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/top-products', { query: { days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows, [{ name: 'Товар', quantity: 1, revenue: 100, profit: 10 }]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].from, '2023-05-01 00:00:00', 'якорь — первый день месяца старейшего заказа');
  assert.match(windows[0].to, /^\d{4}-\d{2}-\d{2} 23:59:00$/, 'верх окна — сейчас, как у живых окон');

  // days=30 сразу после «Всё» обязан сходить в МС сам: кэш-ключ включает days.
  await invoke(routes, 'GET /api/ms/top-products', { query: { days: '30' } });
  assert.equal(windows.length, 2, '30-дневное окно не подменяется кэшем «Всё»');
  assert.notEqual(windows[1].from, windows[0].from, 'живое окно короче полного диапазона');
  assert.equal(oldestCalls.length, 1, 'живое окно архивный якорь не трогает');

  // Повторное «Всё» — из своего (часового) кэша.
  await invoke(routes, 'GET /api/ms/top-products', { query: { days: '0' } });
  assert.equal(windows.length, 2, 'повторное «Всё» отвечает из кэша');
});

test('top-products: days=0 на пустом архиве — консервативный фолбэк 2020-01-01', async () => {
  let seenFrom = null;
  const { routes } = buildMs({
    msFetch: async (_token, path) => {
      const q = new URLSearchParams(path.split('?')[1] || '');
      seenFrom = q.get('momentFrom');
      return { rows: [] };
    },
    db: { getMsOldestOrderDayForActor: async () => null },
  });
  const res = await invoke(routes, 'GET /api/ms/top-products', { query: { days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { rows: [], total: 0, truncated: false });
  assert.equal(seenFrom, '2020-01-01 00:00:00');
});

test('top-customers: sinceDay-окно в repo, имена ОДНИМ OR-вызовом словаря, кэш-хит вторым вызовом', async () => {
  const fetches = [];
  const repoCalls = [];
  const { routes } = buildMs({
    msFetch: async (token, path) => {
      assert.equal(token, 'TOKEN:enc');
      fetches.push(path);
      assert.ok(path.startsWith('/entity/counterparty?'), path);
      assert.ok(!path.includes(';'), `фильтр обязан быть URL-encoded целиком (голый ';' в: ${path})`);
      const q = new URLSearchParams(path.split('?')[1] || '');
      assert.equal(q.get('filter'), 'id=cp-a;id=cp-b', 'OR-фильтр по всем id топа');
      assert.equal(q.get('limit'), '2', 'limit = числу строк топа');
      // cp-b словарь не вернул (контрагент удалён) — его имя обязано стать null, не роняя роут.
      return { rows: [{ id: 'cp-a', name: 'ООО Ромашка' }] };
    },
    db: {
      getMsTopCustomersForActor: async (channelId, actor, opts) => {
        repoCalls.push(opts);
        assert.equal(channelId, 5);
        assert.equal(actor.uid, 7);
        assert.match(opts.sinceDay, /^\d{4}-\d{2}-\d{2}$/, 'days>0 → нижняя граница окна');
        return [
          { agent_id: 'cp-a', orders: 5, sum_kopecks: 100000 },
          { agent_id: 'cp-b', orders: 2, sum_kopecks: 4050 },
        ];
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/top-customers', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    window_days: 30,
    rows: [
      { agent_id: 'cp-a', name: 'ООО Ромашка', orders: 5, sum: 1000 },
      { agent_id: 'cp-b', name: null, orders: 2, sum: 40.5 },
    ],
  });
  assert.equal(fetches.length, 1, 'имена всего топа — ровно один вызов словаря');
  const second = await invoke(routes, 'GET /api/ms/top-customers', { query: { days: '30' } });
  assert.deepEqual(second.body, res.body);
  assert.equal(fetches.length, 1, 'повторный ответ — из кэша');
  assert.equal(repoCalls.length, 1, 'кэш укрывает и DB-агрегат');
});

test('top-customers: сбой словаря → name:null без кэша; days=0 → вся история; 401/403 → ms_token_revoked', async () => {
  let dictCalls = 0;
  let seenSince = 'UNSET';
  const { routes } = buildMs({
    msFetch: async () => {
      dictCalls += 1;
      const e = new Error('МойСклад: HTTP 500');
      e.status = 500;
      throw e;
    },
    db: {
      getMsTopCustomersForActor: async (_channelId, _actor, opts) => {
        seenSince = opts.sinceDay;
        return [{ agent_id: 'cp-a', orders: 1, sum_kopecks: 100 }];
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/top-customers', { query: { days: '0' } });
  assert.equal(res.statusCode, 200, 'DB-агрегат не заложник живого МС');
  assert.deepEqual(res.body.rows, [{ agent_id: 'cp-a', name: null, orders: 1, sum: 1 }]);
  assert.equal(seenSince, null, 'days=0 = вся история (sinceDay null)');
  await invoke(routes, 'GET /api/ms/top-customers', { query: { days: '0' } });
  assert.equal(dictCalls, 2, 'деградированный ответ не кэшируется — имена пробуются снова');

  const revoked = buildMs({
    msFetch: async () => {
      const e = new Error('МойСклад: HTTP 403');
      e.status = 403;
      throw e;
    },
    db: { getMsTopCustomersForActor: async () => [{ agent_id: 'cp-a', orders: 1, sum_kopecks: 100 }] },
  });
  const r2 = await invoke(revoked.routes, 'GET /api/ms/top-customers', { query: { days: '7' } });
  assert.equal(r2.statusCode, 401, 'отозванный токен не маскируется под name:null');
  assert.equal(r2.body.code, 'ms_token_revoked');
});

test('sales-by-channel: словарь saleschannel мапит name/type, NULL-канал → no_channel_orders, словарь кэшируется', async () => {
  const dictPaths = [];
  const { routes } = buildMs({
    msFetch: async (token, path) => {
      assert.equal(token, 'TOKEN:enc');
      dictPaths.push(path);
      assert.equal(path, '/entity/saleschannel?limit=100', 'одна страница словаря каналов');
      return { rows: [
        { id: 'ch-site', name: 'Сайт - Notem tilda', type: 'ECOMMERCE' },
        { id: 'ch-direct', name: 'Instagram Direct', type: 'SOCIAL_NETWORK' },
      ] };
    },
    db: {
      getMsSalesByChannelForActor: async (channelId, actor, opts) => {
        assert.equal(channelId, 5);
        assert.equal(actor.uid, 7);
        assert.match(opts.sinceDay, /^\d{4}-\d{2}-\d{2}$/, 'days>0 → нижняя граница окна');
        return [
          { sales_channel_id: 'ch-site', orders: 10, sum_kopecks: 500000 },
          { sales_channel_id: 'ch-direct', orders: 4, sum_kopecks: 120000 },
          { sales_channel_id: 'ch-gone', orders: 2, sum_kopecks: 3000 },   // снят — в словаре нет
          { sales_channel_id: null, orders: 3, sum_kopecks: 750 },
        ];
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/sales-by-channel', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    window_days: 30,
    total_orders: 19,          // 10+4+2+3 (NULL-канал тоже в total)
    no_channel_orders: 3,      // строка sales_channel_id=NULL — счётчиком, не в rows
    rows: [
      { sales_channel_id: 'ch-site', name: 'Сайт - Notem tilda', type: 'ECOMMERCE', orders: 10, sum: 5000 },
      { sales_channel_id: 'ch-direct', name: 'Instagram Direct', type: 'SOCIAL_NETWORK', orders: 4, sum: 1200 },
      { sales_channel_id: 'ch-gone', name: null, type: null, orders: 2, sum: 30 },  // снятый канал → null
    ],
  });
  await invoke(routes, 'GET /api/ms/sales-by-channel', { query: { days: '30' } });
  assert.equal(dictPaths.length, 1, 'второй запрос берёт словарь каналов из кэша (1 час)');
});

test('sales-by-channel: словарь деградирует мягко (name/type null) и НЕ кэшируется; days=0 → вся история; 401/403 → ms_token_revoked', async () => {
  let dictCalls = 0;
  let seenSince = 'UNSET';
  const { routes } = buildMs({
    msFetch: async () => {
      dictCalls += 1;
      const e = new Error('МойСклад: HTTP 500');
      e.status = 500;
      throw e;
    },
    db: {
      getMsSalesByChannelForActor: async (_channelId, _actor, opts) => {
        seenSince = opts.sinceDay;
        return [{ sales_channel_id: 'ch-site', orders: 1, sum_kopecks: 100 }];
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/sales-by-channel', { query: { days: '0' } });
  assert.equal(res.statusCode, 200, 'DB-агрегат не заложник живого МС');
  assert.deepEqual(res.body.rows, [{ sales_channel_id: 'ch-site', name: null, type: null, orders: 1, sum: 1 }]);
  assert.equal(seenSince, null, 'days=0 = вся история (sinceDay null)');
  await invoke(routes, 'GET /api/ms/sales-by-channel', { query: { days: '0' } });
  assert.equal(dictCalls, 2, 'неуспех словаря не кэшируется — следующий запрос пробует снова');

  // 401/403 = отозванный токен, не молчаливый name:null (как top-customers).
  const revoked = buildMs({
    msFetch: async () => {
      const e = new Error('МойСклад: HTTP 403');
      e.status = 403;
      throw e;
    },
    db: { getMsSalesByChannelForActor: async () => [{ sales_channel_id: 'ch-site', orders: 1, sum_kopecks: 100 }] },
  });
  const r2 = await invoke(revoked.routes, 'GET /api/ms/sales-by-channel', { query: { days: '7' } });
  assert.equal(r2.statusCode, 401, 'отозванный токен не маскируется под name:null');
  assert.equal(r2.body.code, 'ms_token_revoked');
});

test('geography: sinceDay-окно в repo, копейки → рубли, total/no_city проброшены, БЕЗ словаря и БЕЗ кэша', async () => {
  const repoCalls = [];
  const { routes } = buildMs({
    msFetch: async () => { throw new Error('geography не ходит в МС'); },
    db: {
      getMsGeographyForActor: async (channelId, actor, opts) => {
        repoCalls.push(opts);
        assert.equal(channelId, 5);
        assert.equal(actor.uid, 7);
        assert.match(opts.sinceDay, /^\d{4}-\d{2}-\d{2}$/, 'days>0 → нижняя граница окна');
        return {
          total_orders: 20,
          no_city_orders: 5,
          rows: [
            { city: 'Москва', orders: 9, sum_kopecks: 900000 },
            { city: 'Каспийск', orders: 6, sum_kopecks: 250050 },
          ],
        };
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/geography', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    window_days: 30,
    total_orders: 20,
    no_city_orders: 5,
    rows: [
      { city: 'Москва', orders: 9, sum: 9000 },
      { city: 'Каспийск', orders: 6, sum: 2500.5 },   // копейки → рубли на границе
    ],
  });
  await invoke(routes, 'GET /api/ms/geography', { query: { days: '30' } });
  assert.equal(repoCalls.length, 2, 'geography без кэша — каждый запрос читает архив заново');
});

test('geography: days=0 → вся история (sinceDay null)', async () => {
  let seenSince = 'UNSET';
  const { routes } = buildMs({
    msFetch: async () => { throw new Error('geography не ходит в МС'); },
    db: {
      getMsGeographyForActor: async (_channelId, _actor, opts) => {
        seenSince = opts.sinceDay;
        return { total_orders: 0, no_city_orders: 0, rows: [] };
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/geography', { query: { days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { window_days: 0, total_orders: 0, no_city_orders: 0, rows: [] });
  assert.equal(seenSince, null);
});

test('channel-series: channel-параметр валидируется (all/junk→null, UUID→фильтр), копейки→рубли, БЕЗ кэша', async () => {
  const seen = [];
  const { routes } = buildMs({
    msFetch: async () => { throw new Error('channel-series не ходит в МС'); },
    db: {
      getMsChannelSeriesForActor: async (channelId, actor, opts) => {
        seen.push(opts.salesChannelId);
        assert.equal(channelId, 5);
        assert.equal(actor.uid, 7);
        return [{ day: '2026-07-15', orders: 2, sum_kopecks: 150000 }];
      },
    },
  });
  // 'all' → null (все каналы)
  const rAll = await invoke(routes, 'GET /api/ms/channel-series', { query: { days: '30', channel: 'all' } });
  assert.equal(rAll.statusCode, 200);
  assert.deepEqual(rAll.body, { window_days: 30, channel: null, series: [{ day: '2026-07-15', orders: 2, sum: 1500 }] });
  // отсутствует → null
  await invoke(routes, 'GET /api/ms/channel-series', { query: { days: '30' } });
  // мусорный channel → null (не пускаем в фильтр)
  await invoke(routes, 'GET /api/ms/channel-series', { query: { days: '30', channel: 'DROP TABLE' } });
  // валидный UUID-подобный id → фильтр
  const id = '16f07379-8039-11ec-0a80-03970021e97d';
  const rId = await invoke(routes, 'GET /api/ms/channel-series', { query: { days: '30', channel: id } });
  assert.equal(rId.body.channel, id);
  assert.deepEqual(seen, [null, null, null, id], 'all/пусто/мусор → null; только UUID проходит в repo');
});

test('connect/disconnect: audit-события ms_connect/ms_disconnect с identity-полями и БЕЗ токена', async () => {
  const saved = [];
  const { routes, audits } = buildMs({
    msFetch: async (token, path) => {
      assert.equal(token, 'SECRET-MS-TOKEN');
      if (path === '/context/employee') return { accountId: 'acc-77' };
      if (path === '/entity/organization') return { rows: [{ name: 'ООО Ромашка' }] };
      throw new Error(`неожиданный path: ${path}`);
    },
    db: {
      findMsChannelByAccount: async () => null,
      createMsChannel: async () => ({ id: 9 }),
      saveMsAccount: async (channelId, acc) => { saved.push({ channelId, acc }); return true; },
      deleteMsAccount: async () => true,
    },
  });
  const res = await invoke(routes, 'POST /api/ms/connect', { body: { token: 'SECRET-MS-TOKEN' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, channel_id: 9, org_name: 'ООО Ромашка' });
  assert.equal(saved[0].acc.access_token_enc, 'enc(SECRET-MS-TOKEN)', 'хранится только шифрованный токен');
  const connected = audits.find((a) => a.action === 'ms_connect');
  assert.ok(connected, 'connect записан в audit');
  assert.deepEqual(connected.meta, { channelId: 9, msAccountId: 'acc-77', orgName: 'ООО Ромашка' });

  // Отключение: владелец канала (owner_uid=7 = uid) проходит admin-гейт воркспейса.
  const del = await invoke(routes, 'DELETE /api/ms/account', {});
  assert.equal(del.statusCode, 200);
  const disconnected = audits.find((a) => a.action === 'ms_disconnect');
  assert.ok(disconnected, 'disconnect записан в audit');
  assert.deepEqual(disconnected.meta, { channelId: 5, msAccountId: 'acc-1' });

  assert.ok(!JSON.stringify(audits).includes('SECRET-MS-TOKEN'), 'токен не попадает в audit-поля');
});
