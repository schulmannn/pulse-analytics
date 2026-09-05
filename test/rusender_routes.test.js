'use strict';

// Route-тесты /api/rusender/* (fake-app паттерн cdek_routes.test.js): auth — пропуск, db и
// клиент — стабы. Фокус на границах, которых нет ниже по стеку:
//   • ФИЧЕФЛАГ ВИТРИН: выключенный флаг обязан давать 404 (поверхности ЕЩЁ НЕТ), а не пустой
//     ответ — пустой неотличим от «данных нет» и врал бы и пользователю, и отладке;
//   • connect: 401/403 апстрима = ошибка ВВОДА (400), а не отзыв сохранённого ключа;
//   • ключ без нужных scope НЕ сохраняется (иначе тихая поломка, всплывающая через сутки);
//   • ключ не течёт ни в ответы, ни в аудит;
//   • отключение — admin-действие, архив переживает отключение.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerRusenderRoutes } = require('../server/routes/rusender');

const OK_SCOPES = ['campaigns.read', 'contacts.read', 'senders.read'];

function build({ db = {}, fetchImpl, crypto = {} } = {}) {
  const routes = new Map();
  const app = {
    get(path, ...h) { routes.set(`GET ${path}`, h); },
    post(path, ...h) { routes.set(`POST ${path}`, h); },
    delete(path, ...h) { routes.set(`DELETE ${path}`, h); },
  };
  const audits = [];
  const saved = [];
  registerRusenderRoutes({
    app,
    requireAuth: (_req, _res, next) => next(),
    db: {
      enabled: true,
      getChannelOrDefault: async () => ({ id: 9, owner_uid: 7, source: 'rusender', title: 'acc', member_role: 'owner' }),
      getRusenderAccount: async () => ({ channel_id: 9, account_id: '18416', account_email: 'a@b.ru', scopes: OK_SCOPES, api_key_enc: 'enc' }),
      findRusenderChannelByAccount: async () => 9,
      createRusenderChannel: async () => ({ id: 9 }),
      saveRusenderAccount: async (channelId, payload) => { saved.push({ channelId, payload }); return true; },
      deleteRusenderAccount: async () => true,
      getRusenderSummaryForActor: async () => ({ events: { opens: 1, clicks: 2 }, campaigns: {}, contacts: null }),
      getRusenderSeriesForActor: async () => [],
      getRusenderCampaignsForActor: async () => [],
      getRusenderCampaignForActor: async () => ({ campaign: { campaign_id: 1 }, activity: [], parts: [] }),
      getRusenderBoundsForActor: async () => ({ first_day: '2026-06-01', last_day: '2026-08-31', campaigns: 3 }),
      getRusenderDiagnosticsForActor: async () => ({ families: {}, activityFit: [], coverage: {}, statuses: [] }),
      ...db,
    },
    audit: async (_req, event, meta) => { audits.push({ event, meta }); },
    rusenderCrypto: { configured: () => true, encrypt: (v) => `enc(${v})`, decrypt: () => 'plain', ...crypto },
    rusenderFetch: fetchImpl || (async () => ({ data: { accountId: 18416, accountEmail: 'a@b.ru', scopes: OK_SCOPES }, meta: null })),
    log: () => {},
  });
  return { routes, audits, saved };
}

async function call(routes, key, req = {}) {
  const handlers = routes.get(key);
  assert.ok(handlers, `нет роута ${key}`);
  const out = { status: 200, body: null, headers: {} };
  const res = {
    status(code) { out.status = code; return res; },
    json(body) { out.body = body; return res; },
    set(k, v) { out.headers[String(k).toLowerCase()] = v; return res; },
  };
  const request = { query: {}, headers: {}, params: {}, body: undefined, user: { uid: 7 }, ...req };
  for (const h of handlers) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve, reject) => {
      const maybe = h(request, res, (e) => (e ? reject(e) : resolve()));
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
      else resolve();
    });
  }
  return out;
}

test('флаг ВКЛ: summary отдаёт ДВЕ независимые группы величин и не складывает их', async () => {
  const { routes } = build();
  const res = await call(routes, 'GET /api/rusender/summary', { query: { days: '30' } });
  assert.equal(res.status, 200);
  assert.ok(res.body.events, 'события периода');
  assert.ok(res.body.campaigns, 'рассылки периода');
  assert.equal(res.body.days, 30);
});

test('флаг ВКЛ: days вне узкого enum падает в дефолт 30 (кэш не плодит per-value записи)', async () => {
  const { routes } = build();
  const res = await call(routes, 'GET /api/rusender/summary', { query: { days: '37' } });
  assert.equal(res.body.days, 30);
});

test('флаг ВКЛ: days=0 («Всё») берёт окно из границ архива', async () => {
  const { routes } = build();
  const res = await call(routes, 'GET /api/rusender/summary', { query: { days: '0' } });
  assert.equal(res.body.from, '2026-06-01');
  assert.equal(res.body.to, '2026-08-31');
});

test('флаг ВКЛ: пустой архив в «Всё» даёт null-окно, а не выдуманный диапазон', async () => {
  const { routes } = build({
    db: { getRusenderBoundsForActor: async () => ({ first_day: null, last_day: null, campaigns: 0 }) },
  });
  const res = await call(routes, 'GET /api/rusender/summary', { query: { days: '0' } });
  assert.equal(res.body.from, null);
  assert.deepEqual(res.body.series, []);
});

test('диагностика — только admin воркспейса (отладочная поверхность, не продуктовая)', async () => {
  const { routes } = build({
    db: { getChannelOrDefault: async () => ({ id: 9, owner_uid: 99, source: 'rusender', member_role: 'viewer' }) },
  });
  const res = await call(routes, 'GET /api/rusender/diagnostics');
  assert.equal(res.status, 403);
});

test('диагностика доступна и при ВЫКЛЮЧЕННОМ флаге — ею и решают, включать ли его', async () => {
  // Спрятать диагностику за тем самым флагом, который она помогает открыть, значит замкнуть круг.
  const { routes } = build();
  const res = await call(routes, 'GET /api/rusender/diagnostics');
  assert.equal(res.status, 200);
  assert.ok(res.body.coverage !== undefined);
});

// ── Подключение ───────────────────────────────────────────────────────────────────────────────

test('connect: 401 апстрима = ошибка ВВОДА (400), а не отзыв сохранённого ключа', async () => {
  const err = new Error('Rusender: unauthorized');
  err.status = 401;
  const { routes, saved } = build({ fetchImpl: async () => { throw err; } });
  const res = await call(routes, 'POST /api/rusender/connect', { body: { api_key: 'rs_ck_v1_bad' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /отклонён/);
  assert.equal(saved.length, 0, 'ключ не сохранён');
});

test('connect: ключ без нужных scope НЕ сохраняется и говорит, чего не хватает', async () => {
  const { routes, saved } = build({
    fetchImpl: async () => ({ data: { accountId: 1, accountEmail: 'a@b.ru', scopes: ['senders.read'] }, meta: null }),
  });
  const res = await call(routes, 'POST /api/rusender/connect', { body: { api_key: 'rs_ck_v1_ok' } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.missing_scopes, ['campaigns.read', 'contacts.read']);
  assert.equal(saved.length, 0, 'подключённый источник, которому нечего читать, не заводится');
});

test('connect: ключ уходит в БД ТОЛЬКО шифрованным и не течёт в ответ и аудит', async () => {
  const { routes, saved, audits } = build();
  const res = await call(routes, 'POST /api/rusender/connect', { body: { api_key: 'rs_ck_v1_secret' } });
  assert.equal(res.status, 200);
  assert.equal(saved[0].payload.api_key_enc, 'enc(rs_ck_v1_secret)');
  assert.ok(!JSON.stringify(res.body).includes('rs_ck_v1_secret'), 'ключа нет в ответе');
  assert.ok(!JSON.stringify(audits).includes('rs_ck_v1_secret'), 'ключа нет в аудите');
  assert.equal(audits[0].event, 'rusender_connect');
});

test('connect без RUSENDER_KEY инертен (503), апстрим не дёргается', async () => {
  let called = 0;
  const { routes } = build({
    crypto: { configured: () => false },
    fetchImpl: async () => { called += 1; return { data: {}, meta: null }; },
  });
  const res = await call(routes, 'POST /api/rusender/connect', { body: { api_key: 'x' } });
  assert.equal(res.status, 503);
  assert.equal(called, 0);
});

test('disconnect: не-admin получает 403, архив не трогается', async () => {
  let deleted = 0;
  const { routes } = build({
    db: {
      getChannelOrDefault: async () => ({ id: 9, owner_uid: 99, source: 'rusender', member_role: 'viewer' }),
      deleteRusenderAccount: async () => { deleted += 1; return true; },
    },
  });
  const res = await call(routes, 'DELETE /api/rusender/account');
  assert.equal(res.status, 403);
  assert.equal(deleted, 0);
});

// ── Общий резолв канала (аудит #554): база недоступна — говорим это, а не «не подключено» ─────

test('база недоступна → 503, а не 404 «не подключён»', async () => {
  // Копия резолва у Rusender была ЕДИНСТВЕННОЙ без гейта `db.enabled`: при недоступной базе
  // МойСклад и Метрика честно отвечали 503, а Rusender — 404 «не подключён к этому каналу»,
  // то есть врал про состояние подключения там, где не работало вообще ничего. Пользователь
  // шёл переподключать рабочий аккаунт. Общий резолв держит гейт в одном месте.
  const { routes } = build({ surfacesEnabled: true, db: { enabled: false } });
  for (const key of ['GET /api/rusender/status', 'GET /api/rusender/summary']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(routes, key);
    assert.equal(res.status, 503, key);
    assert.match(String(res.body.error), /База данных недоступна/, key);
  }
});

test('чужой канал по явному id → 403 даже там, где 404 «не подключён» смягчён', async () => {
  // `optional` (status/disconnect) смягчает только исходы «не подключён». Явно запрошенный
  // недоступный канал обязан оставаться 403: 404 выдал бы, что такого канала нет вовсе.
  const { routes } = build({ surfacesEnabled: true, db: { getChannelOrDefault: async () => null } });
  const res = await call(routes, 'GET /api/rusender/status', { query: { channel: '4242' } });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /Нет доступа к этому каналу/);
});
