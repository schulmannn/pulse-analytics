'use strict';

// Route-тесты Яндекс.Метрики (fake-app паттерн ms_analytics_routes.test): auth — pass-middleware,
// db/ymFetch/ymCrypto — стабы, кэш — реальный memoryCache (без start(), таймеров нет). Фокус:
//   • /api/ym/connect — один счётчик → создание канала + шифрованный токен + audit БЕЗ токена;
//     несколько счётчиков → choice_required со списком; counter_id выбирает/валидируется;
//     401 upstream'а = «токен отклонён» (400), пустой список счётчиков = 400;
//   • /api/ym/summary — живое окно: плотная дневная серия с нулями + кэш-хит; days=0 («Всё») —
//     ИЗ АРХИВА без единого fetch'а; кривой диапазон → 400;
//   • /api/ym/sources — маппинг строк + totals как авторитет; 401 после connect'а →
//     ym_token_revoked (reconnect-CTA);
//   • DELETE /api/ym/account — admin-гейт воркспейса, идемпотентность;
//   • decrypt-fail → честный 503 (серверная деградация, не «не подключён»).

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerYmRoutes } = require('../server/routes/metrika');
const { createMemoryCache } = require('../server/infrastructure/memoryCache');

function buildYm({ ymFetch, db = {}, crypto = {} } = {}) {
  const routes = new Map();
  const app = {
    get(path, ...h) { routes.set(`GET ${path}`, h); },
    post(path, ...h) { routes.set(`POST ${path}`, h); },
    put(path, ...h) { routes.set(`PUT ${path}`, h); },
    delete(path, ...h) { routes.set(`DELETE ${path}`, h); },
  };
  const pass = (_req, _res, next) => next();
  const cache = createMemoryCache({});
  const audits = [];
  registerYmRoutes({
    app,
    requireAuth: pass,
    db: {
      enabled: true,
      getChannelOrDefault: async () => ({ id: 5, owner_uid: 7 }),
      getYmAccount: async () => ({
        channel_id: 5, counter_id: 'cnt-1', counter_name: 'notem.ru', site: 'notem.ru',
        counter_created_day: '2024-03-01', access_token_enc: 'enc',
      }),
      ...db,
    },
    audit: async (_req, action, meta) => { audits.push({ action, meta }); },
    ymCrypto: { configured: () => true, decrypt: (enc) => `TOKEN:${enc}`, encrypt: (t) => `enc(${t})`, ...crypto },
    ymFetch,
    cacheGet: cache.get,
    cacheSet: cache.set,
    cache,
    log: () => {},
  });
  return { routes, audits, cache };
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

const COUNTER = { id: 65383336, name: 'nōtem', site2: { site: 'notem.ru' }, create_time: '2024-03-01T12:00:00+03:00' };

test('connect: один счётчик — канал создан, токен сохранён ШИФРОВАННЫМ, audit без токена', async () => {
  const saved = [];
  const { routes, audits } = buildYm({
    ymFetch: async (_t, path) => {
      assert.ok(path.startsWith('/management/v1/counters'));
      return { counters: [COUNTER] };
    },
    db: {
      findYmChannelByCounter: async () => null,
      createYmChannel: async ({ owner_uid, name }) => ({ id: 42, owner_uid, title: name }),
      saveYmAccount: async (channelId, fields) => { saved.push({ channelId, fields }); return true; },
    },
  });
  const res = await invoke(routes, 'POST /api/ym/connect', { body: { token: 'oauth-secret' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, channel_id: 42, counter_name: 'nōtem', site: 'notem.ru' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].channelId, 42);
  assert.equal(saved[0].fields.counter_id, '65383336');
  assert.equal(saved[0].fields.counter_created_day, '2024-03-01');
  assert.equal(saved[0].fields.access_token_enc, 'enc(oauth-secret)', 'в БД уходит только шифроблоб');
  assert.deepEqual(audits, [{ action: 'ym_connect', meta: { channelId: 42, counterId: '65383336', counterName: 'nōtem' } }]);
  assert.ok(!JSON.stringify(audits).includes('oauth-secret'), 'токена нет в audit-metadata');
});

test('connect: несколько счётчиков без counter_id → choice_required со списком identity-полей', async () => {
  const { routes } = buildYm({
    ymFetch: async () => ({ counters: [COUNTER, { id: 111, name: 'второй', site: 'b.ru' }] }),
  });
  const res = await invoke(routes, 'POST /api/ym/connect', { body: { token: 't' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.choice_required, true);
  assert.deepEqual(res.body.counters, [
    { id: '65383336', name: 'nōtem', site: 'notem.ru' },
    { id: '111', name: 'второй', site: 'b.ru' },
  ]);
});

test('connect: counter_id выбирает счётчик; чужой id → 400 без утечки списка', async () => {
  const saved = [];
  const mk = () => buildYm({
    ymFetch: async () => ({ counters: [COUNTER, { id: 111, name: 'второй' }] }),
    db: {
      findYmChannelByCounter: async () => 42,
      saveYmAccount: async (channelId, fields) => { saved.push({ channelId, fields }); return true; },
    },
  });
  const ok = await invoke(mk().routes, 'POST /api/ym/connect', { body: { token: 't', counter_id: '111' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(saved[0].fields.counter_id, '111');

  const bad = await invoke(mk().routes, 'POST /api/ym/connect', { body: { token: 't', counter_id: '999' } });
  assert.equal(bad.statusCode, 400);
  assert.ok(!JSON.stringify(bad.body).includes('65383336'));
});

test('connect: 401/403 апстрима = присланный токен не подошёл → 400; пустой список счётчиков → 400', async () => {
  const rejected = buildYm({
    ymFetch: async () => { const e = new Error('Яндекс.Метрика: Invalid oauth_token'); e.status = 403; throw e; },
  });
  const r1 = await invoke(rejected.routes, 'POST /api/ym/connect', { body: { token: 'bad' } });
  assert.equal(r1.statusCode, 400);
  assert.match(r1.body.error, /отклонён/i);

  const empty = buildYm({ ymFetch: async () => ({ counters: [] }) });
  const r2 = await invoke(empty.routes, 'POST /api/ym/connect', { body: { token: 't' } });
  assert.equal(r2.statusCode, 400);
});

test('status: optional-резолв — connected:false без учётки, identity-поля с учёткой (без токена)', async () => {
  const off = buildYm({ ymFetch: async () => ({}), db: { getYmAccount: async () => null } });
  const r1 = await invoke(off.routes, 'GET /api/ym/status');
  assert.deepEqual(r1.body, { connected: false, counter_name: null, counter_id: null, site: null });

  const on = buildYm({ ymFetch: async () => ({}) });
  const r2 = await invoke(on.routes, 'GET /api/ym/status');
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.body, { connected: true, counter_name: 'notem.ru', counter_id: 'cnt-1', site: 'notem.ru' });
  assert.ok(!JSON.stringify(r2.body).includes('enc'), 'шифроблоб наружу не уходит');
});

test('summary (живое окно): плотная дневная серия с нулями, повторный вызов — из кэша', async () => {
  let fetches = 0;
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      fetches += 1;
      assert.ok(path.includes('date1=2026-07-01') && path.includes('date2=2026-07-03'));
      assert.ok(path.includes('accuracy=full'));
      return { data: [{ dimensions: [{ name: '2026-07-02' }], metrics: [10, 7, 25] }] };
    },
  });
  const q = { days: '30', from: '2026-07-01', to: '2026-07-03' };
  const res = await invoke(routes, 'GET /api/ym/summary', { query: q });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.visits, {
    total: 10,
    series: [
      { day: '2026-07-01', value: 0 },
      { day: '2026-07-02', value: 10 },
      { day: '2026-07-03', value: 0 },
    ],
  });
  assert.equal(res.body.users.total, 7);
  assert.equal(res.body.pageviews.total, 25);
  const again = await invoke(routes, 'GET /api/ym/summary', { query: q });
  assert.equal(again.statusCode, 200);
  assert.equal(fetches, 1, 'второй ответ — кэш-хит, к Метрике не ходили');
});

test('summary days=0 («Всё»): читается ИЗ АРХИВА ym_daily, ни одного fetch\'а и без токена', async () => {
  let fetches = 0;
  const { routes } = buildYm({
    ymFetch: async () => { fetches += 1; return {}; },
    db: {
      getYmDailyAllForActor: async (channelId, actor) => {
        assert.equal(channelId, 5);
        assert.equal(actor.uid, 7);
        return [
          { day: '2026-06-01', visits: 3, users: 2, pageviews: 5 },
          { day: '2026-06-02', visits: 4, users: 3, pageviews: 6 },
        ];
      },
    },
    // decrypt взорвался бы, если бы архивная ветка потрогала токен.
    crypto: { decrypt: () => { throw new Error('не должен вызываться'); } },
  });
  const res = await invoke(routes, 'GET /api/ym/summary', { query: { days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.equal(fetches, 0);
  assert.equal(res.body.visits.total, 7);
  assert.deepEqual(res.body.users.series.map((p) => p.value), [2, 3]);
});

test('summary: кривой диапазон (from>to / мусор) → 400, к Метрике не ходим', async () => {
  let fetches = 0;
  const { routes } = buildYm({ ymFetch: async () => { fetches += 1; return {}; } });
  const r1 = await invoke(routes, 'GET /api/ym/summary', { query: { from: '2026-07-05', to: '2026-07-01' } });
  assert.equal(r1.statusCode, 400);
  const r2 = await invoke(routes, 'GET /api/ym/summary', { query: { from: 'мусор', to: '2026-07-01' } });
  assert.equal(r2.statusCode, 400);
  assert.equal(fetches, 0);
});

test('sources: маппинг строк + totals полного отчёта авторитетнее суммы среза', async () => {
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      assert.ok(path.includes('lastsignTrafficSource'));
      assert.ok(path.includes('lang=ru'));
      return {
        data: [
          { dimensions: [{ id: 'organic', name: 'Переходы из поисковых систем' }], metrics: [70, 50] },
          { dimensions: [{ id: 'direct', name: 'Прямые заходы' }], metrics: [20, 15] },
        ],
        totals: [100, 80],
      };
    },
  });
  const res = await invoke(routes, 'GET /api/ym/sources', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    visits_total: 100,
    users_total: 80,
    rows: [
      { id: 'organic', name: 'Переходы из поисковых систем', visits: 70, users: 50 },
      { id: 'direct', name: 'Прямые заходы', visits: 20, users: 15 },
    ],
  });
});

test('sources «Всё»: date1 = дата создания счётчика, date2 = сегодня', async () => {
  const paths = [];
  const { routes } = buildYm({
    ymFetch: async (_t, path) => { paths.push(path); return { data: [], totals: [0, 0] }; },
  });
  const res = await invoke(routes, 'GET /api/ym/sources', { query: { days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.equal(paths.length, 1);
  assert.ok(paths[0].includes('date1=2024-03-01'), 'якорь «Всё» — counter_created_day учётки');
});

test('data-роут при отозванном токене (401 Метрики) → 401 + code ym_token_revoked (reconnect-CTA)', async () => {
  const { routes } = buildYm({
    ymFetch: async () => { const e = new Error('Яндекс.Метрика: Invalid oauth_token'); e.status = 401; throw e; },
  });
  const res = await invoke(routes, 'GET /api/ym/summary', { query: { days: '7' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'ym_token_revoked');
});

test('429 Метрики (после внутреннего ретрая клиента) → честный 503 с подсказкой', async () => {
  const { routes } = buildYm({
    ymFetch: async () => { const e = new Error('Яндекс.Метрика: quota exceeded'); e.status = 429; throw e; },
  });
  const res = await invoke(routes, 'GET /api/ym/sources', { query: { days: '7' } });
  assert.equal(res.statusCode, 503);
});

test('decrypt-fail сохранённого токена → 503 (серверная деградация, не «не подключён»)', async () => {
  const { routes } = buildYm({
    ymFetch: async () => ({}),
    crypto: { decrypt: () => { throw new Error('bad blob'); } },
  });
  const res = await invoke(routes, 'GET /api/ym/summary', { query: { days: '7' } });
  assert.equal(res.statusCode, 503);
});

test('DELETE /api/ym/account: владелец отключает + audit; не-участник — 403 и учётка жива', async () => {
  const deleted = [];
  const mk = (owner) => buildYm({
    ymFetch: async () => ({}),
    db: {
      getChannelOrDefault: async () => ({ id: 5, owner_uid: owner }),
      deleteYmAccount: async (id) => { deleted.push(id); return true; },
    },
  });
  const own = mk(7);
  const r1 = await invoke(own.routes, 'DELETE /api/ym/account');
  assert.equal(r1.statusCode, 200);
  assert.deepEqual(deleted, [5]);
  assert.deepEqual(own.audits, [{ action: 'ym_disconnect', meta: { channelId: 5, counterId: 'cnt-1' } }]);

  const stranger = mk(8);   // owner_uid=8, req.user.uid=7, member_role нет
  const r2 = await invoke(stranger.routes, 'DELETE /api/ym/account');
  assert.equal(r2.statusCode, 403);
  assert.equal(deleted.length, 1, 'учётка чужого воркспейса не тронута');
});

test('connect/summary при незаданном YM_TOKEN_KEY → честный 503 (инертная вертикаль)', async () => {
  const { routes } = buildYm({ ymFetch: async () => ({}), crypto: { configured: () => false } });
  const r1 = await invoke(routes, 'POST /api/ym/connect', { body: { token: 't' } });
  assert.equal(r1.statusCode, 503);
  const r2 = await invoke(routes, 'GET /api/ym/summary', { query: { days: '7' } });
  assert.equal(r2.statusCode, 503);
});
