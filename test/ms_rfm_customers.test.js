'use strict';

// Route-тесты /api/ms/rfm-customers (fake-app паттерн ms_analytics_routes.test): auth —
// pass-middleware, db/msFetch/msCrypto — стабы, кэш — реальный memoryCache. Фокус:
//   • happy-path — сегмент/окно/asOf доходят до repo, имена+адреса+phone/email живым словарём
//     counterparty, копейки→рубли, city/last_day/scores в строках, кэш-хит вторым вызовом;
//   • деградация словаря (не-401/403) → name/address/phone/email:null БЕЗ кэша;
//     401/403 → ms_token_revoked;
//   • 400 на неизвестный segment (repo не вызывается) и на кривой диапазон from/to;
//   • пагинация ПОСЛЕ фильтра+сортировки: limit/offset-срез, клампы (1..200 / >=0), словарь
//     ТОЛЬКО по id строк страницы чанками по 25; пустая страница кэшируется без словаря.

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
    sleepFn: async () => {},
  });
  return { routes };
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

// Domain-форма ответа repo: ПОЛНЫЙ отсортированный список сегмента (пагинация — забота роута).
const listing = (customers) => ({
  as_of: '2026-07-18', total_customers: customers.length, customers,
});

test('rfm-customers: сегмент/окно в repo, имена+адреса ОДНИМ вызовом словаря, кэш-хит вторым вызовом', async () => {
  const fetches = [];
  const repoCalls = [];
  const { routes } = buildMs({
    msFetch: async (token, path) => {
      assert.equal(token, 'TOKEN:enc');
      fetches.push(path);
      assert.ok(path.startsWith('/entity/counterparty?'), path);
      assert.ok(!path.includes(';'), `фильтр обязан быть URL-encoded целиком (голый ';' в: ${path})`);
      const q = new URLSearchParams(path.split('?')[1] || '');
      assert.equal(q.get('filter'), 'id=cp-a;id=cp-b', 'OR-фильтр по id строк страницы');
      assert.equal(q.get('limit'), '2', 'limit = числу строк чанка');
      // cp-b словарь не вернул (контрагент удалён) — name/address/phone/email обязаны стать null,
      // не роняя роут. email отсутствует и у cp-a (не строка) → null зеркально name/actualAddress.
      return {
        rows: [{
          id: 'cp-a', name: 'ООО Ромашка', actualAddress: 'г Москва, Тверская 1',
          phone: '+7 900 000-00-01',
        }],
      };
    },
    db: {
      getMsRfmCustomersForActor: async (channelId, actor, opts) => {
        repoCalls.push(opts);
        assert.equal(channelId, 5);
        assert.equal(actor.uid, 7);
        assert.equal(opts.segment, 'champions');
        assert.match(opts.sinceDay, /^\d{4}-\d{2}-\d{2}$/, 'days>0 → нижняя граница окна');
        assert.match(opts.untilDay, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(opts.asOfDay, opts.untilDay, 'recency считается на конец окна');
        return listing([
          {
            agent_id: 'cp-a', recency_days: 1, orders: 5, sum_kopecks: 100000,
            r: 5, f: 5, m: 5, last_day: '2026-07-17', city: 'Москва',
          },
          {
            agent_id: 'cp-b', recency_days: 8, orders: 2, sum_kopecks: 4050,
            r: 4, f: 4, m: 4, last_day: '2026-07-10', city: null,
          },
        ]);
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/rfm-customers', { query: { days: '30', segment: 'champions' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    window_days: 30,
    as_of: '2026-07-18',
    segment: 'champions',
    total_customers: 2,
    rows: [
      {
        agent_id: 'cp-a', name: 'ООО Ромашка', address: 'г Москва, Тверская 1',
        phone: '+7 900 000-00-01', email: null, city: 'Москва',
        orders: 5, sum: 1000, last_day: '2026-07-17', recency_days: 1, r: 5, f: 5, m: 5,
      },
      {
        agent_id: 'cp-b', name: null, address: null, phone: null, email: null, city: null,
        orders: 2, sum: 40.5, last_day: '2026-07-10', recency_days: 8, r: 4, f: 4, m: 4,
      },
    ],
  });
  assert.equal(fetches.length, 1, 'страница ≤25 строк — ровно один вызов словаря');
  const second = await invoke(routes, 'GET /api/ms/rfm-customers', { query: { days: '30', segment: 'champions' } });
  assert.deepEqual(second.body, res.body);
  assert.equal(fetches.length, 1, 'повторный ответ — из кэша');
  assert.equal(repoCalls.length, 1, 'кэш укрывает и DB-агрегат');
});

test('rfm-customers: сбой словаря → name/address:null без кэша; days=0 → вся история; 401/403 → ms_token_revoked', async () => {
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
      getMsRfmCustomersForActor: async (_channelId, _actor, opts) => {
        seenSince = opts.sinceDay;
        return listing([{
          agent_id: 'cp-a', recency_days: 3, orders: 1, sum_kopecks: 100,
          r: 3, f: 3, m: 3, last_day: '2026-07-15', city: null,
        }]);
      },
    },
  });
  const res = await invoke(routes, 'GET /api/ms/rfm-customers', { query: { days: '0', segment: 'new' } });
  assert.equal(res.statusCode, 200, 'DB-агрегат не заложник живого МС');
  assert.deepEqual(res.body.rows, [{
    agent_id: 'cp-a', name: null, address: null, phone: null, email: null, city: null,
    orders: 1, sum: 1, last_day: '2026-07-15', recency_days: 3, r: 3, f: 3, m: 3,
  }]);
  assert.equal(seenSince, null, 'days=0 = вся история (sinceDay null)');
  await invoke(routes, 'GET /api/ms/rfm-customers', { query: { days: '0', segment: 'new' } });
  assert.equal(dictCalls, 2, 'деградированный ответ не кэшируется — словарь пробуется снова');

  const revoked = buildMs({
    msFetch: async () => {
      const e = new Error('МойСклад: HTTP 403');
      e.status = 403;
      throw e;
    },
    db: {
      getMsRfmCustomersForActor: async () => listing([{
        agent_id: 'cp-a', recency_days: 3, orders: 1, sum_kopecks: 100,
        r: 3, f: 3, m: 3, last_day: '2026-07-15', city: null,
      }]),
    },
  });
  const r2 = await invoke(revoked.routes, 'GET /api/ms/rfm-customers', { query: { days: '7', segment: 'new' } });
  assert.equal(r2.statusCode, 401, 'отозванный токен не маскируется под name:null');
  assert.equal(r2.body.code, 'ms_token_revoked');
});

test('rfm-customers: неизвестный/отсутствующий segment → 400 без чтения repo; кривой диапазон → 400', async () => {
  const { routes } = buildMs({
    msFetch: async () => { throw new Error('словарь не должен вызываться при 400'); },
    db: {
      getMsRfmCustomersForActor: async () => { throw new Error('репо не должен вызываться при 400'); },
    },
  });
  const unknown = await invoke(routes, 'GET /api/ms/rfm-customers', { query: { days: '30', segment: 'vip' } });
  assert.equal(unknown.statusCode, 400);
  const missing = await invoke(routes, 'GET /api/ms/rfm-customers', { query: { days: '30' } });
  assert.equal(missing.statusCode, 400);
  const badRange = await invoke(routes, 'GET /api/ms/rfm-customers', {
    query: { segment: 'loyal', from: '2026-07-31', to: '2026-07-01' },
  });
  assert.equal(badRange.statusCode, 400);
});

test('rfm-customers: пагинация ПОСЛЕ фильтра+сортировки — срез offset/limit, словарь только по странице', async () => {
  const fetches = [];
  const all = ['cp-1', 'cp-2', 'cp-3', 'cp-4'].map((id, i) => ({
    agent_id: id, recency_days: 10, orders: 4 - i, sum_kopecks: (4 - i) * 1000,
    r: 3, f: 3, m: 3, last_day: '2026-07-01', city: null,
  }));
  const { routes } = buildMs({
    msFetch: async (_token, path) => {
      fetches.push(path);
      const q = new URLSearchParams(path.split('?')[1] || '');
      assert.equal(q.get('filter'), 'id=cp-2;id=cp-3', 'словарь — ТОЛЬКО id строк страницы');
      return { rows: [] };
    },
    db: { getMsRfmCustomersForActor: async () => listing(all) },
  });
  const res = await invoke(routes, 'GET /api/ms/rfm-customers', {
    query: { days: '30', segment: 'loyal', limit: '2', offset: '1' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total_customers, 4, 'total_customers — счётчик ДО пагинации');
  assert.deepEqual(res.body.rows.map((row) => row.agent_id), ['cp-2', 'cp-3']);
  assert.equal(fetches.length, 1);

  // offset за пределами списка → пустая страница без словаря; кэшируется (второй вызов без repo).
  let repoCalls = 0;
  const empty = buildMs({
    msFetch: async () => { throw new Error('пустая страница не должна ходить в словарь'); },
    db: {
      getMsRfmCustomersForActor: async () => {
        repoCalls += 1;
        return listing(all);
      },
    },
  });
  const out = await invoke(empty.routes, 'GET /api/ms/rfm-customers', {
    query: { days: '30', segment: 'loyal', offset: '100' },
  });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body.rows, []);
  assert.equal(out.body.total_customers, 4);
  await invoke(empty.routes, 'GET /api/ms/rfm-customers', {
    query: { days: '30', segment: 'loyal', offset: '100' },
  });
  assert.equal(repoCalls, 1, 'пустая страница — честный ответ, кэшируется');
});

test('rfm-customers: клампы limit (1..200) и offset (>=0), словарь чанками по 25 id', async () => {
  const fetches = [];
  const all = Array.from({ length: 230 }, (_, i) => ({
    agent_id: `cp-${String(i).padStart(3, '0')}`, recency_days: 10, orders: 2, sum_kopecks: (230 - i) * 100,
    r: 3, f: 3, m: 3, last_day: '2026-07-01', city: null,
  }));
  const { routes } = buildMs({
    msFetch: async (_token, path) => {
      const q = new URLSearchParams(path.split('?')[1] || '');
      const ids = q.get('filter').split(';').map((cond) => cond.replace(/^id=/, ''));
      fetches.push(ids);
      assert.equal(String(ids.length), q.get('limit'), 'limit чанка = числу его id');
      assert.ok(ids.length <= 25, `чанк словаря не больше 25 id (пришло ${ids.length})`);
      return { rows: [] };
    },
    db: { getMsRfmCustomersForActor: async () => listing(all) },
  });
  const res = await invoke(routes, 'GET /api/ms/rfm-customers', {
    query: { days: '30', segment: 'loyal', limit: '500', offset: '-5' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rows.length, 200, 'limit кламп до 200');
  assert.equal(res.body.rows[0].agent_id, 'cp-000', 'offset кламп до 0');
  assert.equal(res.body.total_customers, 230);
  assert.equal(fetches.length, 8, '200 строк страницы = 8 чанков по 25');
  assert.deepEqual(
    fetches.flat(),
    all.slice(0, 200).map((row) => row.agent_id),
    'чанки покрывают ровно страницу, в её порядке',
  );
});
