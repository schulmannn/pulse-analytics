'use strict';

// Focused unit tests для дневного сбора Rusender (jobs/rusenderCollectionJob). Без сети:
// rusenderFetch/fetchAllPages — программируемые фейки по path; db — фейк с записью upsert'ов и
// passthrough runJobOnce.
//
// Главное, что здесь проверяется, — ЗАЩИТА ОТ ДВОЙНОГО СЧЁТА A/B. Спека Rusender предупреждает,
// что `stats` базовой рассылки В СПИСКЕ это агрегат по семье; если варианты приезжают ещё и
// отдельными строками, наивная сумма посчитает семью дважды (класс альбомов Telegram). Проверить
// это на живом аккаунте пока нечем, поэтому защита структурная (parent_id, миграция 040) и
// покрыта тестами на ОБЕ возможные реальности: варианты приходят отдельной строкой и не приходят.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRusenderCollectionJob,
  campaignRowsFromLists,
  contactsRow,
  activityRows,
} = require('../server/jobs/rusenderCollectionJob');

const ACC = { channel_id: 9, account_id: '18416', api_key_enc: 'enc-1' };

/** Метрика кампании в форме Rusender: { count, rate }. Витрины берут только count. */
const metric = (count) => ({ count, rate: 42 });

const baseCampaign = (over = {}) => ({
  id: 100,
  name: 'Июньская рассылка',
  subject: 'Что нового',
  previewTitle: 'Смотрите внутри',
  type: 'regular',
  status: 'completed',
  senderEmail: 'hi@shop.ru',
  senderName: 'Шоп',
  lists: [{ id: 1, name: 'Основной список' }],
  isArchived: false,
  scheduledAt: '2026-06-01T10:00:00.000Z',
  startedAt: '2026-06-01T10:01:00.000Z',
  finishedAt: '2026-06-01T11:00:00.000Z',
  createdAt: '2026-05-31T12:00:00.000Z',
  stats: {
    total: 1000,
    sending: metric(990),
    delivered: metric(950),
    open: metric(400),
    click: metric(120),
    error: metric(20),
    unsubscribe: metric(5),
    complaint: metric(2),
  },
  ...over,
});

function makeDb(over = {}) {
  const calls = { daily: [], campaigns: [], activity: [], picked: [] };
  return {
    enabled: true,
    calls,
    async upsertRusenderDaily(channelId, rows) { calls.daily.push({ channelId, rows }); return rows.length; },
    async upsertRusenderCampaigns(channelId, rows) { calls.campaigns.push({ channelId, rows }); return rows.length; },
    async upsertRusenderCampaignActivity(channelId, campaignId, rows) {
      calls.activity.push({ channelId, campaignId, rows });
      return rows.length;
    },
    async listRusenderCampaignsForActivity(channelId) { calls.picked.push(channelId); return [100]; },
    async listRusenderAccounts() { return [ACC]; },
    async runJobOnce(_job, _key, fn) { return { skipped: false, result: await fn() }; },
    ...over,
  };
}

function makeJob({ db = makeDb(), pages = {}, single = {}, crypto: cryptoOver } = {}) {
  const logs = [];
  const job = createRusenderCollectionJob({
    db,
    rusenderFetch: async (_key, path) => {
      if (path in single) {
        const v = single[path];
        if (v instanceof Error) throw v;
        return { data: v, meta: null };
      }
      throw new Error(`unexpected fetch ${path}`);
    },
    fetchAllPages: async (_key, path) => (pages[path] || []),
    rusenderCrypto: cryptoOver || { configured: () => true, decrypt: () => 'plain-key' },
    log: (level, event, meta) => logs.push({ level, event, meta }),
  });
  return { job, db, logs };
}

// ── Разбор форм ответа ────────────────────────────────────────────────────────────────────────

test('campaignRow: метрики берутся из count, а не из rate; total — голое число', () => {
  const [row] = campaignRowsFromLists([baseCampaign()]);
  assert.equal(row.campaign_id, 100);
  assert.equal(row.total, 1000);
  assert.equal(row.sending, 990);
  assert.equal(row.delivered, 950);
  assert.equal(row.opens, 400);
  assert.equal(row.clicks, 120);
  assert.equal(row.errors, 20);
  assert.equal(row.unsubscribes, 5);
  assert.equal(row.complaints, 2);
  assert.deepEqual(row.list_names, ['Основной список']);
  assert.equal(row.parent_id, null);
});

test('campaignRow: без stats счётчики NULL, а не нули («статистики нет» ≠ «ноль доставленных»)', () => {
  const [row] = campaignRowsFromLists([baseCampaign({ stats: undefined, status: 'draft', startedAt: null })]);
  assert.equal(row.total, null);
  assert.equal(row.delivered, null);
  assert.equal(row.opens, null);
  assert.equal(row.started_at, null);
});

// ── A/B: защита от двойного счёта ─────────────────────────────────────────────────────────────

test('A/B: части семьи получают parent_id, база остаётся базой', () => {
  const rows = campaignRowsFromLists([
    baseCampaign({
      id: 100,
      type: 'ab_basic',
      parts: [
        { id: 101, role: 'ab_variant', name: 'Вариант A', status: 'completed' },
        { id: 102, role: 'ab_variant', name: 'Вариант B', status: 'completed' },
      ],
    }),
  ]);
  const byId = new Map(rows.map((r) => [r.campaign_id, r]));
  assert.equal(byId.size, 3, 'база + два варианта');
  assert.equal(byId.get(100).parent_id, null);
  assert.equal(byId.get(101).parent_id, 100);
  assert.equal(byId.get(101).family_role, 'ab_variant');
  assert.equal(byId.get(102).parent_id, 100);
});

test('A/B: вариант, пришедший ОТДЕЛЬНОЙ строкой списка, не теряет parent_id и не удваивает строку', () => {
  // Реальность №1: сервер отдаёт и базу с parts[], и сами варианты как самостоятельные элементы.
  // Строки обязаны схлопнуться по campaign_id, а принадлежность семье — пережить схлопывание,
  // иначе вариант вернулся бы в итоги и посчитал семью дважды.
  const variant = baseCampaign({ id: 101, name: 'Вариант A', type: 'ab_variant' });
  const rows = campaignRowsFromLists([
    baseCampaign({ id: 100, type: 'ab_basic', parts: [{ id: 101, role: 'ab_variant', name: 'Вариант A', status: 'completed' }] }),
    variant,
  ]);
  const ids = rows.map((r) => r.campaign_id).sort((a, b) => a - b);
  assert.deepEqual(ids, [100, 101], 'дубля строки нет');
  const v = rows.find((r) => r.campaign_id === 101);
  assert.equal(v.parent_id, 100, 'принадлежность семье пережила схлопывание');
  assert.equal(v.delivered, 950, 'статистика из полноценного элемента списка сохранена');
});

test('A/B: вариант, встреченный ДО своей базы, всё равно получает parent_id (порядок страниц не гарантирован)', () => {
  const rows = campaignRowsFromLists([
    baseCampaign({ id: 101, name: 'Вариант A', type: 'ab_variant' }),
    baseCampaign({ id: 100, type: 'ab_basic', parts: [{ id: 101, role: 'ab_variant', name: 'Вариант A', status: 'completed' }] }),
  ]);
  assert.equal(rows.find((r) => r.campaign_id === 101).parent_id, 100);
});

test('без семей поведение прежнее: обычные рассылки все базовые', () => {
  // Реальность №2: составных рассылок нет вовсе — защита не должна ничего менять.
  const rows = campaignRowsFromLists([baseCampaign({ id: 1 }), baseCampaign({ id: 2 })]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.parent_id === null));
});

test('дедуп по campaign_id: пересечение архивной и обычной выборок не роняет батч', () => {
  // Две выборки (archived=false/true) могут пересечься, а ON CONFLICT в одном батче на
  // дублирующем ключе падает («cannot affect row a second time»).
  const rows = campaignRowsFromLists([baseCampaign({ id: 7 }), baseCampaign({ id: 7, isArchived: true })]);
  assert.equal(rows.length, 1);
});

// ── Снимок базы и дневной ряд ─────────────────────────────────────────────────────────────────

test('contactsRow: счётчики берутся как есть; отсутствующее поле остаётся NULL', () => {
  const row = contactsRow({ total: 5000, active: 3000, unsubscribed: 200 }, '2026-08-31');
  assert.equal(row.contacts_total, 5000);
  assert.equal(row.contacts_active, 3000);
  assert.equal(row.contacts_unsubscribed, 200);
  assert.equal(row.contacts_unavailable, null, 'нет поля — не ложный ноль');
});

test('activityRows: кривой день отбрасывается, ISO-время режется до дня', () => {
  const rows = activityRows({ items: [
    { date: '2026-06-01', opens: 10, clicks: 3 },
    { date: '2026-06-02T00:00:00.000Z', opens: 5, clicks: 1 },
    { date: 'не дата', opens: 99, clicks: 99 },
    { date: null, opens: 1, clicks: 1 },
  ] });
  assert.deepEqual(rows, [
    { day: '2026-06-01', opens: 10, clicks: 3 },
    { day: '2026-06-02', opens: 5, clicks: 1 },
  ]);
});

// ── Проход ────────────────────────────────────────────────────────────────────────────────────

test('проход: снимок базы, рассылки обеих выборок и активность пачки', async () => {
  const { job, db } = makeJob({
    pages: {
      '/v1/public/campaigns?withStats=true': [baseCampaign({ id: 100 })],
      '/v1/public/campaigns?withStats=true&archived=true': [baseCampaign({ id: 200, isArchived: true })],
    },
    single: {
      '/v1/public/contacts/statistics': { total: 5000, active: 3000, unsubscribed: 200, unavailable: 150 },
      '/v1/public/campaigns/100/activity': { items: [{ date: '2026-06-01', opens: 10, clicks: 3 }] },
    },
  });
  const out = await job.runRusenderCollectionPass();
  assert.equal(out.channels, 1);
  assert.equal(out.errors, 0);
  assert.equal(db.calls.daily.length, 1);
  assert.equal(db.calls.daily[0].rows[0].contacts_total, 5000);
  // Архивные ОБЯЗАНЫ приехать: без второй выборки история обрывалась бы на архивации.
  const ids = db.calls.campaigns[0].rows.map((r) => r.campaign_id).sort((a, b) => a - b);
  assert.deepEqual(ids, [100, 200]);
  assert.equal(db.calls.activity[0].campaignId, 100);
});

test('сбой активности ОДНОЙ рассылки не рушит проход и не отменяет собранные рассылки', async () => {
  const err = new Error('Rusender: HTTP 500');
  err.status = 500;
  const { job, db, logs } = makeJob({
    pages: { '/v1/public/campaigns?withStats=true': [baseCampaign({ id: 100 })] },
    single: {
      '/v1/public/contacts/statistics': { total: 10 },
      '/v1/public/campaigns/100/activity': err,
    },
  });
  const out = await job.runRusenderCollectionPass();
  assert.equal(out.channels, 1, 'проход завершился');
  assert.equal(db.calls.campaigns.length, 1, 'рассылки записаны, несмотря на сбой активности');
  assert.ok(logs.some((l) => l.event === 'rusender_activity_failed'));
});

test('битый ключ шифрования: warn+skip БЕЗ claim day-gate (после починки день ещё соберётся)', async () => {
  let claimed = 0;
  const db = makeDb({ async runJobOnce(_j, _k, fn) { claimed += 1; return { skipped: false, result: await fn() }; } });
  const { job, logs } = makeJob({
    db,
    crypto: { configured: () => true, decrypt: () => { throw new Error('bad ciphertext'); } },
  });
  const out = await job.runRusenderCollectionPass();
  assert.equal(claimed, 0, 'день не сожжён');
  assert.equal(out.errors, 1);
  assert.ok(logs.some((l) => l.event === 'rusender_key_decrypt_failed'));
});

test('без RUSENDER_KEY и без БД проход инертен', async () => {
  const { job: noKey } = makeJob({ crypto: { configured: () => false, decrypt: () => 'x' } });
  assert.deepEqual(await noKey.runRusenderCollectionPass(), { channels: 0, campaigns: 0, activity: 0, errors: 0, skipped: 0 });
  const { job: noDb } = makeJob({ db: makeDb({ enabled: false }) });
  assert.deepEqual(await noDb.runRusenderCollectionPass(), { channels: 0, campaigns: 0, activity: 0, errors: 0, skipped: 0 });
});

test('day-gate закрыт → проход считает аккаунт пропущенным, а не собранным', async () => {
  const db = makeDb({ async runJobOnce() { return { skipped: true }; } });
  const { job } = makeJob({ db });
  const out = await job.runRusenderCollectionPass();
  assert.equal(out.skipped, 1);
  assert.equal(out.channels, 0);
});
