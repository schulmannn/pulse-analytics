'use strict';

// Route-тесты Яндекс.Метрики (fake-app паттерн ms_analytics_routes.test): auth — pass-middleware,
// db/ymFetch/ymCrypto — стабы, кэш — реальный memoryCache (без start(), таймеров нет). Фокус:
//   • /api/ym/connect — один счётчик → создание канала + шифрованный токен + audit БЕЗ токена;
//     несколько счётчиков → choice_required со списком; counter_id выбирает/валидируется;
//     401 upstream'а = «токен отклонён» (400), пустой список счётчиков = 400;
//   • /api/ym/summary — живое окно: плотная дневная серия с нулями + кэш-хит; days=0 («Всё») —
//     архивные серии + best-effort live-итоги/качество; кривой диапазон → 400;
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

test('summary days=0 («Всё»): при нечитаемом токене остаётся архивным без live-fetch', async () => {
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
    // Best-effort decrypt падает, но архивная ветка не падает вслед за ним.
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

// ── Слайс 2: цели / топ-страницы / UTM ──────────────────────────────────────────────────────

const goalsDict = (goals) => ({ goals });
const goalStat = (pairs) => ({ data: [], totals: pairs.flat() });

test('goals: словарь + один батч ≤10 целей, сортировка по reaches, conversionRate из своей метрики', async () => {
  const paths = [];
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      paths.push(path);
      if (path.startsWith('/management/v1/counter/cnt-1/goals')) {
        return goalsDict([{ id: 11, name: 'Заказ' }, { id: 22, name: 'Подписка' }]);
      }
      // totals выровнены по порядку metrics: [reaches11, cr11, reaches22, cr22]
      return goalStat([[5, 1.25], [40, 3.333]]);
    },
  });
  const res = await invoke(routes, 'GET /api/ym/goals', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    truncated: false,
    rows: [
      { id: '22', name: 'Подписка', reaches: 40, conversion_rate: 3.33 },
      { id: '11', name: 'Заказ', reaches: 5, conversion_rate: 1.25 },
    ],
  });
  const stat = paths.find((p) => p.startsWith('/stat/'));
  assert.ok(stat.includes('ym%3As%3Agoal11reaches%2Cym%3As%3Agoal11conversionRate') || stat.includes('ym:s:goal11reaches,ym:s:goal11conversionRate'));
  assert.equal(paths.filter((p) => p.startsWith('/stat/')).length, 1, '2 цели = один батч');
});

test('goals: словарь кэшируется час, 12 целей → 2 батча, 25 → truncated и только первые 20', async () => {
  const counts = { dict: 0, stat: 0 };
  const many = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `Цель ${i + 1}` }));
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      if (path.startsWith('/management/')) { counts.dict += 1; return goalsDict(many); }
      counts.stat += 1;
      return { data: [], totals: Array.from({ length: 20 }, () => 1) };
    },
  });
  const r1 = await invoke(routes, 'GET /api/ym/goals', { query: { days: '30' } });
  assert.equal(r1.body.truncated, true);
  assert.equal(r1.body.rows.length, 20, 'потолок 20 целей');
  assert.equal(counts.stat, 2, '20 целей = 2 батча по 10 пар метрик');
  // Другое окно: словарь из кэша (dict всё ещё 1), отчёты новые.
  await invoke(routes, 'GET /api/ym/goals', { query: { days: '7' } });
  assert.equal(counts.dict, 1, 'словарь целей часовой — повторно не ходили');
  assert.equal(counts.stat, 4);
});

test('goals: кривой id цели из словаря НЕ попадает в имена метрик (числовой гейт)', async () => {
  const paths = [];
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      paths.push(path);
      if (path.startsWith('/management/')) {
        return goalsDict([{ id: 'DROP TABLE', name: 'зловред' }, { id: 33, name: 'Честная' }]);
      }
      return goalStat([[7, 2]]);
    },
  });
  const res = await invoke(routes, 'GET /api/ym/goals', { query: { days: '30' } });
  assert.deepEqual(res.body.rows.map((r) => r.id), ['33']);
  const stat = paths.find((p) => p.startsWith('/stat/'));
  assert.ok(!stat.includes('DROP'), 'нечисловой id отфильтрован до сборки metrics');
});

test('goals: пустой словарь → rows:[] без stat-запроса; сбой словаря → маппинг sendYmError', async () => {
  let stats = 0;
  const empty = buildYm({
    ymFetch: async (_t, path) => {
      if (path.startsWith('/management/')) return goalsDict([]);
      stats += 1;
      return goalStat([]);
    },
  });
  const r1 = await invoke(empty.routes, 'GET /api/ym/goals', { query: { days: '30' } });
  assert.deepEqual(r1.body, { rows: [], truncated: false });
  assert.equal(stats, 0);

  const broken = buildYm({
    ymFetch: async () => { const e = new Error('Яндекс.Метрика: Invalid oauth_token'); e.status = 401; throw e; },
  });
  const r2 = await invoke(broken.routes, 'GET /api/ym/goals', { query: { days: '30' } });
  assert.equal(r2.statusCode, 401);
  assert.equal(r2.body.code, 'ym_token_revoked');
});

test('pages: pv-неймспейс, маппинг строк + totals, limit клампится в 1..50 и живёт в кэш-ключе', async () => {
  const paths = [];
  const mk = () => buildYm({
    ymFetch: async (_t, path) => {
      paths.push(path);
      return {
        data: [
          { dimensions: [{ name: '/catalog' }], metrics: [500, 300] },
          { dimensions: [{ name: '/' }], metrics: [200, 180] },
        ],
        totals: [900, 600],
      };
    },
  });
  const { routes } = mk();
  const res = await invoke(routes, 'GET /api/ym/pages', { query: { days: '30' } });
  assert.deepEqual(res.body, {
    pageviews_total: 900,
    rows: [
      { path: '/catalog', pageviews: 500, users: 300 },
      { path: '/', pageviews: 200, users: 180 },
    ],
  });
  assert.ok(paths[0].includes('ym%3Apv%3AURLPath') || paths[0].includes('ym:pv:URLPath'));
  assert.ok(paths[0].includes('limit=10'), 'дефолтный limit');

  const clamped = await invoke(mk().routes, 'GET /api/ym/pages', { query: { days: '30', limit: '999' } });
  assert.equal(clamped.statusCode, 200);
  assert.ok(paths.at(-1).includes('limit=50'), 'потолок 50');
  // Разные limit не делят кэш-запись: второй вызов с limit=50 из кэша, счётчик путей не растёт.
  const before = paths.length;
  await invoke(routes, 'GET /api/ym/pages', { query: { days: '30' } });
  assert.equal(paths.length, before, 'limit=10 окна 30 дн — кэш-хит');
});

test('utm: null-строка уходит в untagged_visits, tagged = total − untagged, размеченные — в rows', async () => {
  const { routes } = buildYm({
    ymFetch: async () => ({
      data: [
        { dimensions: [{ id: null, name: null }], metrics: [60, 40] },
        { dimensions: [{ id: 'instagram', name: 'instagram' }], metrics: [30, 20] },
        { dimensions: [{ id: 'tg', name: 'tg' }], metrics: [10, 8] },
      ],
      totals: [100, 68],
    }),
  });
  const res = await invoke(routes, 'GET /api/ym/utm', { query: { days: '30' } });
  assert.deepEqual(res.body, {
    visits_total: 100,
    tagged_visits: 40,
    untagged_visits: 60,
    rows: [
      { id: 'instagram', name: 'instagram', visits: 30, users: 20 },
      { id: 'tg', name: 'tg', visits: 10, users: 8 },
    ],
  });
});

test('goals/pages/utm «Всё»: date1 — counter_created_day учётки (общий allRangeWindow)', async () => {
  const paths = [];
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      paths.push(path);
      if (path.startsWith('/management/')) return goalsDict([{ id: 1, name: 'Цель' }]);
      return { data: [], totals: [0, 0] };
    },
  });
  await invoke(routes, 'GET /api/ym/pages', { query: { days: '0' } });
  await invoke(routes, 'GET /api/ym/utm', { query: { days: '0' } });
  await invoke(routes, 'GET /api/ym/goals', { query: { days: '0' } });
  const statPaths = paths.filter((p) => p.startsWith('/stat/'));
  assert.equal(statPaths.length, 3);
  for (const p of statPaths) assert.ok(p.includes('date1=2024-03-01'), `якорь «Всё» в ${p.slice(0, 40)}…`);
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

// ── Слайс качества: качество трафика, «Всё»-обогащение, лендинги, квота 420 ────────────────────

test('summary (окно): точные ИТОГИ и качество из body.totals; дневные проценты НЕ суммируются', async () => {
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      // Порядок метрик — контракт: visits,users,pageviews,bounce,avgDur,pageDepth,newUsers,pctNew.
      assert.ok(path.includes('ym:s:bounceRate'));
      assert.ok(path.includes('ym:s:pageDepth'));
      assert.ok(path.includes('ym:s:percentNewVisitors'));
      return {
        data: [
          { dimensions: [{ name: '2026-07-01' }], metrics: [30, 20, 60] },
          { dimensions: [{ name: '2026-07-02' }], metrics: [70, 40, 190] },
        ],
        // Дневные отказы были бы 40 и 60 — но период-отказ из totals = 45, НЕ 100 и НЕ сумма.
        totals: [100, 55, 250, 45, 96.4, 2.5, 34, 61.2],
      };
    },
  });
  const res = await invoke(routes, 'GET /api/ym/summary', { query: { from: '2026-07-01', to: '2026-07-02' } });
  assert.equal(res.statusCode, 200);
  // Итоги визитов/посетителей/просмотров — период-точные (из totals), НЕ сумма дневных строк
  // (сумма дала бы visits 100 — совпадает, но users сумма=60≠55, pageviews сумма=250 — из totals).
  assert.equal(res.body.visits.total, 100);
  assert.equal(res.body.users.total, 55, 'посетители — период-уникальные из totals, не сумма 60');
  assert.equal(res.body.pageviews.total, 250);
  // Дневная серия при этом остаётся дневной.
  assert.deepEqual(res.body.visits.series.map((p) => p.value), [30, 70]);
  assert.deepEqual(res.body.quality, {
    bounce_rate: 45,
    avg_visit_duration_seconds: 96.4,
    page_depth: 2.5, // точная периодная ym:s:pageDepth (по определению Метрики = pageviews/visits)
    new_users: 34,
    percent_new_visitors: 61.2,
  });
  assert.equal(res.body.meta.exact_period_totals, true);
  assert.equal(res.body.meta.all_time, false);
});

test('summary (окно): пустой totals падает на суммы дней, качество = null, exact=false', async () => {
  const { routes } = buildYm({
    ymFetch: async () => ({
      data: [{ dimensions: [{ name: '2026-07-02' }], metrics: [10, 7, 25] }],
      totals: [],
    }),
  });
  const res = await invoke(routes, 'GET /api/ym/summary', { query: { from: '2026-07-02', to: '2026-07-02' } });
  assert.equal(res.body.visits.total, 10);
  assert.equal(res.body.quality.bounce_rate, null);
  assert.equal(res.body.quality.page_depth, null);
  assert.equal(res.body.meta.exact_period_totals, false);
});

test('summary: при нулевых знаменателях доли/средние = null, счётчик новых = 0', async () => {
  const { routes } = buildYm({
    ymFetch: async () => ({ data: [], totals: [0, 0, 0, 0, 0, 0, 0, 0] }),
  });
  const res = await invoke(routes, 'GET /api/ym/summary', { query: { days: '7' } });
  assert.equal(res.body.quality.page_depth, null);
  assert.equal(res.body.quality.bounce_rate, null);
  assert.equal(res.body.quality.avg_visit_duration_seconds, null);
  assert.equal(res.body.quality.percent_new_visitors, null);
  assert.equal(res.body.quality.new_users, 0);
});

test('summary «Всё»: архивные серии + живое обогащение (точные итоги/качество), кэш обогащения 1ч', async () => {
  let fetches = 0;
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      fetches += 1;
      assert.ok(!path.includes('dimensions=ym:s:date'), 'all-range — no-dim totals-запрос');
      return { data: [], totals: [500, 300, 1200, 38.5, 84, 2.4, 210, 42] };
    },
    db: {
      getYmDailyAllForActor: async () => [
        { day: '2026-06-01', visits: 3, users: 2, pageviews: 5 },
        { day: '2026-06-02', visits: 4, users: 3, pageviews: 6 },
      ],
    },
    // decrypt по умолчанию работает (`TOKEN:enc`) — токен читается, обогащение идёт.
  });
  const res = await invoke(routes, 'GET /api/ym/summary', { query: { days: '0' } });
  assert.equal(res.statusCode, 200);
  // Архивная серия НЕ подменена.
  assert.deepEqual(res.body.visits.series.map((p) => p.value), [3, 4]);
  // Итоги — из живых totals (точные за весь диапазон), а не сумма архива (7).
  assert.equal(res.body.visits.total, 500);
  assert.equal(res.body.quality.bounce_rate, 38.5);
  assert.equal(res.body.meta.exact_period_totals, true);
  assert.equal(res.body.meta.all_time, true);
  assert.equal(res.body.meta.archive_last_day, '2026-06-02');
  // Второй вызов: обогащение из часового кэша — к Метрике повторно не ходим.
  const again = await invoke(routes, 'GET /api/ym/summary', { query: { days: '0' } });
  assert.equal(again.body.visits.total, 500);
  assert.equal(fetches, 1, 'обогащение «Всё» закэшировано на час');
});

test('summary «Всё» без читаемого токена: архив честно рендерится, exact=false, качество null', async () => {
  let fetches = 0;
  const { routes } = buildYm({
    ymFetch: async () => { fetches += 1; return {}; },
    db: {
      getYmDailyAllForActor: async () => [{ day: '2026-06-01', visits: 3, users: 2, pageviews: 5 }],
    },
    crypto: { decrypt: () => { throw new Error('bad blob'); } },
  });
  const res = await invoke(routes, 'GET /api/ym/summary', { query: { days: '0' } });
  assert.equal(res.statusCode, 200);
  assert.equal(fetches, 0, 'без токена живого запроса нет');
  assert.equal(res.body.visits.total, 3, 'база — из архива');
  assert.equal(res.body.meta.exact_period_totals, false);
  assert.equal(res.body.meta.all_time, true);
  assert.equal(res.body.quality.bounce_rate, null);
});

test('summary «Всё»: live-сбой не валит архив и negative-cache не долбит upstream повторно', async () => {
  let fetches = 0;
  const { routes } = buildYm({
    ymFetch: async () => {
      fetches += 1;
      const e = new Error('quota');
      e.status = 420;
      e.retryAfterMs = 120000;
      throw e;
    },
    db: {
      getYmDailyAllForActor: async () => [{ day: '2026-06-01', visits: 3, users: 2, pageviews: 5 }],
    },
  });
  const first = await invoke(routes, 'GET /api/ym/summary', { query: { days: '0' } });
  const second = await invoke(routes, 'GET /api/ym/summary', { query: { days: '0' } });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body.visits.total, 3);
  assert.equal(first.body.meta.exact_period_totals, false);
  assert.equal(fetches, 1, 'после live-сбоя следующий запрос обслужен из короткого negative-cache');
});

test('landings: startURLPath (не PathFull), отказы по строке, totals → visits_total', async () => {
  const paths = [];
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      paths.push(path);
      return {
        data: [
          { dimensions: [{ name: '/catalog' }], metrics: [80, 50, 22.5] },
          { dimensions: [{ name: '/' }], metrics: [40, 30, 55.1] },
        ],
        totals: [130, 88, 30.2],
      };
    },
  });
  const res = await invoke(routes, 'GET /api/ym/landings', { query: { days: '30' } });
  assert.equal(res.statusCode, 200);
  assert.ok(paths[0].includes('ym:s:startURLPath'), 'страница входа — startURLPath');
  assert.ok(!paths[0].includes('PathFull'), 'НЕ PathFull (query-строки — кардинальность/PII)');
  assert.equal(res.body.goal_id, null);
  assert.equal(res.body.visits_total, 130);
  assert.deepEqual(res.body.rows, [
    { path: '/catalog', visits: 80, users: 50, bounce_rate: 22.5 },
    { path: '/', visits: 40, users: 30, bounce_rate: 55.1 },
  ]);
});

test('landings: валидный goal_id → метрики цели в отчёте и в строках; goal_id эхом', async () => {
  const paths = [];
  const { routes } = buildYm({
    ymFetch: async (_t, path) => {
      paths.push(path);
      return { data: [{ dimensions: [{ name: '/lp' }], metrics: [50, 40, 18.0, 6, 12.0] }], totals: [50, 40, 18.0, 6, 12.0] };
    },
  });
  const res = await invoke(routes, 'GET /api/ym/landings', { query: { days: '30', goal_id: '42' } });
  assert.equal(res.statusCode, 200);
  assert.ok(paths[0].includes('ym:s:goal42reaches') && paths[0].includes('ym:s:goal42conversionRate'));
  assert.equal(res.body.goal_id, 42);
  assert.deepEqual(res.body.rows[0], {
    path: '/lp', visits: 50, users: 40, bounce_rate: 18, goal_reaches: 6, goal_conversion: 12,
  });
});

test('landings: инъекционный/кривой goal_id отбрасывается ДО сборки metrics (числовой гейт)', async () => {
  for (const bad of ['7;DROP TABLE', '-1', '1.5', 'abc', '0']) {
    const paths = [];
    const { routes } = buildYm({
      ymFetch: async (_t, path) => { paths.push(path); return { data: [], totals: [0] }; },
    });
    const res = await invoke(routes, 'GET /api/ym/landings', { query: { days: '30', goal_id: bad } });
    assert.equal(res.statusCode, 200, `goal_id=${bad} — базовый отчёт, не 500`);
    assert.equal(res.body.goal_id, null, `goal_id=${bad} не эхом`);
    assert.ok(!paths[0].includes('goal'), `goal_id=${bad} не попал в metrics: ${paths[0].slice(0, 60)}`);
    assert.ok(!paths[0].includes('DROP'), 'инъекция не достигла outbound-запроса');
  }
});

test('квота 420 Метрики → 503 + заголовок Retry-After (не мгновенный ретрай на клиенте)', async () => {
  const { routes } = buildYm({
    ymFetch: async () => {
      const e = new Error('Яндекс.Метрика: Quota exceeded');
      e.status = 420;
      e.quota = true;
      e.retryAfterMs = 120000;
      throw e;
    },
  });
  const res = await invoke(routes, 'GET /api/ym/sources', { query: { days: '7' } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Retry-After'], '120', 'исходный длинный Retry-After 420 дошёл до клиента');
});
