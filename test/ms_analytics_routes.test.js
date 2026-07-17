'use strict';

// Route-тесты слайса 3 МойСклада (fake-app паттерн reports_route/campaigns_route): auth —
// pass-middleware, db/msFetch/msCrypto — стабы, кэш — реальный memoryCache (без start(), таймеров
// нет), пауза page-loop'а — записывающий sleepFn (как в тестах движка бэкфилла). Фокус:
//   • /api/ms/returns — живой page-loop (окно-фильтр целиком URL-encoded, страницы limit/offset,
//     cap → truncated, копейки → рубли на границе, кэш-хит вторым вызовом, ms_token_revoked);
//   • /api/ms/funnel — словарь статусов (int-цвет → '#rrggbb', NULL-строка → no_state_orders,
//     мягкая деградация без словаря, неуспех словаря не кэшируется).

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
      getMsAccount: async () => ({ access_token_enc: 'enc', org_name: 'ООО Ромашка' }),
      ...db,
    },
    msCrypto: { configured: () => true, decrypt: (enc) => `TOKEN:${enc}` },
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

async function invoke(routes, key, { query = {}, headers = {} } = {}) {
  const handler = routes.get(key).at(-1);
  const res = {
    statusCode: 200,
    headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let nextError = null;
  await handler({ query, headers, user: { uid: 7 } }, res, (e) => { nextError = e; });
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
