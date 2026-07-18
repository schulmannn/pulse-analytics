'use strict';

// Integration-тесты агрегатов архива заказов МойСклада (слайс 3: funnel/customers/cohorts;
// слайс 4: top-customers/oldest-order-day; слайс 6: sales-by-channel/geography) — на
// РЕАЛЬНОМ Postgres, образец analytics_repo.integration.test.js. Seed — через write-путь
// db.upsertMsOrders (заодно прогоняет НОВЫЕ колонки state_id/sales_channel_id/city, миграции
// 030/031), чтение — через getMs*Internal/ForActor. Все числа в ассертах посчитаны руками от
// фиксированного сида на канале ch:
//   агент A — 3 заказа в трёх месяцах (когорта 2026-01, offsets 0/1/2);
//   агент B — 2 заказа В ОДНУ СЕКУНДУ (tie: new ровно один — минимальный order_id);
//   агент C — единственный заказ без статуса (когорта 2026-03);
//   2 заказа без agent_id (в new/repeat не участвуют — сноска no_agent_orders);
//   сосед-канал other с заказом — точные числа ниже доказывают channel-изоляцию.
// Слайс-6 поля (канал продаж/город) — на ОТДЕЛЬНОМ канале geoCh (SC_SITE/SC_DIRECT + пара
// заказов без канала; города с/без «г »-префикса + пара без города), чтобы не переписывать
// хэнд-счёт слайсов 3–4; ch/other их не задают (sales_channel_id/city = null у всех строк).
// Без TEST_DATABASE_URL всё SKIP.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
let owner = null;
let stranger = null;
let ch = null;
let other = null;
let geoCh = null;
const nonce = `msa${Date.now().toString(36)}${process.pid}`;

// id статусов — как в проде: устойчивые uuid-подобные строки (последний сегмент state.meta.href).
const S_BLUE = `st-blue-${nonce}`;
const S_RED = `st-red-${nonce}`;
// id каналов продаж (слайс 6) — тоже устойчивые строки (последний сегмент salesChannel.meta.href).
const SC_SITE = `sc-site-${nonce}`;
const SC_DIRECT = `sc-direct-${nonce}`;

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
  owner = await db.createUser({ email: `own.${nonce}@it.local`, pass_hash: 'x', role: 'user', status: 'active' });
  stranger = await db.createUser({ email: `str.${nonce}@it.local`, pass_hash: 'x', role: 'user', status: 'active' });
  ch = await db.createChannel({ owner_uid: owner.id, username: `ms.${nonce}` });
  other = await db.createChannel({ owner_uid: owner.id, username: `ms2.${nonce}` });
  geoCh = await db.createChannel({ owner_uid: owner.id, username: `ms3.${nonce}` });

  // sales_channel_id/city (слайс 6) — опциональные хвостовые параметры: у слайсов 3–4 они null
  // (эти агрегаты их не читают, поэтому старые ассерты не трогают), у слайс-6 сида — заданы.
  const o = (order_id, moment, sum_kopecks, state_id, agent_id, sales_channel_id = null, city = null) => ({
    order_id, moment, sum_kopecks, state: null, state_id, agent_id,
    agent_name: agent_id ? `Имя ${agent_id}` : null,
    sales_channel_id, city,
  });
  await db.upsertMsOrders(ch.id, [
    o('a1', '2026-01-10 10:00:00.000', 1000, S_BLUE, 'agent-a'),
    o('a2', '2026-02-05 11:00:00.000', 2000, S_RED, 'agent-a'),
    o('a3', '2026-03-07 12:00:00.000', 3000, S_BLUE, 'agent-a'),
    o('b1', '2026-02-14 09:00:00.000', 1500, S_BLUE, 'agent-b'),
    o('b2', '2026-02-14 09:00:00.000', 500, S_RED, 'agent-b'),
    o('c1', '2026-03-20 08:00:00.000', 700, null, 'agent-c'),
    o('n1', '2026-03-21 10:00:00.000', 100, S_BLUE, null),
    o('n2', '2026-01-02 07:00:00.000', 50, null, null),
  ]);
  // Сосед-канал того же владельца: его заказ НЕ должен просачиваться в агрегаты ch.
  await db.upsertMsOrders(other.id, [o('z1', '2026-03-05 10:00:00.000', 999900, S_BLUE, 'agent-z')]);

  // Слайс-6 сид (канал/город) на отдельном канале geoCh, чтобы не трогать хэнд-счёт слайсов 3–4:
  //   каналы SC_SITE (g1,g2) и SC_DIRECT (g3,g4) + пара заказов БЕЗ канала (g5,g6);
  //   города «г Москва»/«Москва»/«город Москва» (нормализация схлопывает в один «Москва»),
  //   «г Каспийск» (→ «Каспийск»), пара БЕЗ города (g4,g6 — самовывоз/null).
  await db.upsertMsOrders(geoCh.id, [
    o('g1', '2026-01-10 10:00:00.000', 100000, S_BLUE, 'agent-a', SC_SITE, 'г Москва'),
    o('g2', '2026-01-15 10:00:00.000', 50000, S_BLUE, 'agent-a', SC_SITE, 'Москва'),
    o('g3', '2026-02-10 10:00:00.000', 30000, S_RED, 'agent-b', SC_DIRECT, 'г Каспийск'),
    o('g4', '2026-02-20 10:00:00.000', 20000, S_RED, 'agent-b', SC_DIRECT, null),
    o('g5', '2026-03-01 10:00:00.000', 5000, S_BLUE, 'agent-c', null, 'город Москва'),
    o('g6', '2026-03-05 10:00:00.000', 7000, S_BLUE, 'agent-c', null, null),
  ]);
});

test.after(async () => {
  if (!pool) return;
  // Каналы и ms_orders уходят каскадом за пользователями (FK ON DELETE CASCADE).
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${nonce}%`]);
  await pool.end();
});

test('getMsFunnelInternal: GROUP BY state_id включая NULL, orders DESC, копейки числами (state_id пережил upsert)', { skip }, async () => {
  const rows = await db.getMsFunnelInternal(ch.id, {});
  assert.deepEqual(rows, [
    { state_id: S_BLUE, orders: 4, sum_kopecks: 5600 },   // a1+a3+b1+n1
    { state_id: S_RED, orders: 2, sum_kopecks: 2500 },    // a2+b2 (tie 2=2 → NULL последним)
    { state_id: null, orders: 2, sum_kopecks: 750 },      // c1+n2
  ]);
  // Кривой sinceDay не долетает до SQL — трактуется как вся история (repo не доверяет вызывающему).
  assert.deepEqual(await db.getMsFunnelInternal(ch.id, { sinceDay: 'DROP TABLE' }), rows);
});

test('getMsFunnelInternal: окно sinceDay режет по календарному дню moment', { skip }, async () => {
  assert.deepEqual(await db.getMsFunnelInternal(ch.id, { sinceDay: '2026-03-01' }), [
    { state_id: S_BLUE, orders: 2, sum_kopecks: 3100 },   // a3+n1
    { state_id: null, orders: 1, sum_kopecks: 700 },      // c1
  ]);
});

test('customers (вся история): все клиенты новые, повторные заказы = не-первые, tie в одну секунду → ровно один new', { skip }, async () => {
  const { summary, series } = await db.getMsCustomersInternal(ch.id, {});
  assert.deepEqual(summary, {
    customers: 3,
    new_customers: 3,
    repeat_customers: 0,
    orders_new: 3,                 // a1, b1 (минимальный order_id из tie-пары), c1
    orders_repeat: 3,              // a2, a3, b2
    sum_new_kopecks: 3200,         // 1000+1500+700
    sum_repeat_kopecks: 5500,      // 2000+3000+500
    no_agent_orders: 2,            // n1, n2
    repeat_ever: 2,                // A (3 заказа) и B (2 заказа)
  });
  assert.deepEqual(series, [
    { day: '2026-01-10', new_orders: 1, repeat_orders: 0, sum_new_kopecks: 1000, sum_repeat_kopecks: 0 },
    { day: '2026-02-05', new_orders: 0, repeat_orders: 1, sum_new_kopecks: 0, sum_repeat_kopecks: 2000 },
    { day: '2026-02-14', new_orders: 1, repeat_orders: 1, sum_new_kopecks: 1500, sum_repeat_kopecks: 500 },
    { day: '2026-03-07', new_orders: 0, repeat_orders: 1, sum_new_kopecks: 0, sum_repeat_kopecks: 3000 },
    { day: '2026-03-20', new_orders: 1, repeat_orders: 0, sum_new_kopecks: 700, sum_repeat_kopecks: 0 },
  ]);
});

test('customers (окно): «новый» = первый заказ ЗА ВСЮ историю, а не окна; repeat_ever глобален', { skip }, async () => {
  const { summary, series } = await db.getMsCustomersInternal(ch.id, { sinceDay: '2026-03-01' });
  assert.deepEqual(summary, {
    customers: 2,                  // A (a3) и C (c1) заказывали в окне
    new_customers: 1,              // только C: первый заказ A был до окна
    repeat_customers: 1,
    orders_new: 1,                 // c1
    orders_repeat: 1,              // a3
    sum_new_kopecks: 700,
    sum_repeat_kopecks: 3000,
    no_agent_orders: 1,            // n1 (n2 вне окна)
    repeat_ever: 2,                // константа канала — окно её не меняет
  });
  assert.deepEqual(series, [
    { day: '2026-03-07', new_orders: 0, repeat_orders: 1, sum_new_kopecks: 0, sum_repeat_kopecks: 3000 },
    { day: '2026-03-20', new_orders: 1, repeat_orders: 0, sum_new_kopecks: 700, sum_repeat_kopecks: 0 },
  ]);
});

test('cohorts: когорта = месяц первого заказа, offset 0 = size, нули дозаполнены до горизонта канала', { skip }, async () => {
  assert.deepEqual(await db.getMsCohortsInternal(ch.id), [
    {
      cohort_month: '2026-01', size: 1,   // A активен во всех трёх месяцах
      cells: [{ offset: 0, active: 1 }, { offset: 1, active: 1 }, { offset: 2, active: 1 }],
    },
    {
      cohort_month: '2026-02', size: 1,   // B активен только в своём месяце; март — честный 0
      cells: [{ offset: 0, active: 1 }, { offset: 1, active: 0 }],
    },
    { cohort_month: '2026-03', size: 1, cells: [{ offset: 0, active: 1 }] },
  ]);
});

test('top-customers: сумма DESC, только строки с agent_id, sinceDay-окно и limit', { skip }, async () => {
  // Вся история: A = 1000+2000+3000, B = 1500+500, C = 700; n1/n2 (без агента) не участвуют.
  // agent-z соседнего канала (999900 коп) не просачивается — иначе он возглавил бы топ.
  assert.deepEqual(await db.getMsTopCustomersInternal(ch.id, {}), [
    { agent_id: 'agent-a', orders: 3, sum_kopecks: 6000 },
    { agent_id: 'agent-b', orders: 2, sum_kopecks: 2000 },
    { agent_id: 'agent-c', orders: 1, sum_kopecks: 700 },
  ]);
  // Окно с 2026-03-01: у A остаётся только a3, у C — c1; B выпадает целиком.
  assert.deepEqual(await db.getMsTopCustomersInternal(ch.id, { sinceDay: '2026-03-01' }), [
    { agent_id: 'agent-a', orders: 1, sum_kopecks: 3000 },
    { agent_id: 'agent-c', orders: 1, sum_kopecks: 700 },
  ]);
  // limit режет хвост ПОСЛЕ сортировки; кривой sinceDay не долетает до SQL — вся история.
  assert.deepEqual(
    (await db.getMsTopCustomersInternal(ch.id, { limit: 1 })).map((r) => r.agent_id),
    ['agent-a'],
  );
  assert.equal((await db.getMsTopCustomersInternal(ch.id, { sinceDay: 'DROP TABLE' })).length, 3);
});

test('oldest-order-day: MIN(moment) канала как YYYY-MM-DD, каналы изолированы', { skip }, async () => {
  assert.equal(await db.getMsOldestOrderDayInternal(ch.id), '2026-01-02');      // n2 — старейший
  // Сосед видит СВОЙ минимум (не 2026-01-02 канала ch) — изоляция в обе стороны.
  assert.equal(await db.getMsOldestOrderDayInternal(other.id), '2026-03-05');
  // Канал без заказов — честный null (граница API подставит консервативный фолбэк).
  assert.equal(await db.getMsOldestOrderDayInternal(2147480000), null);
});

test('sales-by-channel (слайс 6): GROUP BY sales_channel_id включая NULL, сумма DESC, окно и изоляция', { skip }, async () => {
  // geoCh: SC_SITE g1+g2=150000, SC_DIRECT g3+g4=50000, БЕЗ канала g5+g6=12000.
  assert.deepEqual(await db.getMsSalesByChannelInternal(geoCh.id, {}), [
    { sales_channel_id: SC_SITE, orders: 2, sum_kopecks: 150000 },
    { sales_channel_id: SC_DIRECT, orders: 2, sum_kopecks: 50000 },
    { sales_channel_id: null, orders: 2, sum_kopecks: 12000 },   // NULL-канал последним (NULLS LAST)
  ]);
  // Окно с 2026-02-01 срезает январские SC_SITE-заказы целиком.
  assert.deepEqual(await db.getMsSalesByChannelInternal(geoCh.id, { sinceDay: '2026-02-01' }), [
    { sales_channel_id: SC_DIRECT, orders: 2, sum_kopecks: 50000 },
    { sales_channel_id: null, orders: 2, sum_kopecks: 12000 },
  ]);
  // Кривой sinceDay не долетает до SQL — вся история (repo не доверяет вызывающему).
  assert.equal((await db.getMsSalesByChannelInternal(geoCh.id, { sinceDay: 'DROP TABLE' })).length, 3);
  // Канал-изоляция: все 8 заказов ch имеют sales_channel_id=null (слайс-6 поля им не задавали) →
  // ровно одна NULL-строка, и никаких SC_SITE/SC_DIRECT geoCh.
  assert.deepEqual(await db.getMsSalesByChannelInternal(ch.id, {}), [
    { sales_channel_id: null, orders: 8, sum_kopecks: 8850 },
  ]);
});

test('geography (слайс 6): нормализация схлопывает «г Москва»/«Москва»/«город Москва», no_city_orders, окно и изоляция', { skip }, async () => {
  // Москва = g1+g2+g5 (155000), Каспийск = g3 (30000); g4+g6 без города → no_city_orders.
  assert.deepEqual(await db.getMsGeographyInternal(geoCh.id, {}), {
    rows: [
      { city: 'Москва', orders: 3, sum_kopecks: 155000 },
      { city: 'Каспийск', orders: 1, sum_kopecks: 30000 },
    ],
    total_orders: 6,
    no_city_orders: 2,
  });
  // Окно с 2026-02-01: январские «Москва»-заказы (g1,g2) выпадают; остаётся Каспийск (g3) и
  // «город Москва» (g5, нормализуется в «Москва»); g4,g6 — no_city.
  assert.deepEqual(await db.getMsGeographyInternal(geoCh.id, { sinceDay: '2026-02-01' }), {
    rows: [
      { city: 'Каспийск', orders: 1, sum_kopecks: 30000 },
      { city: 'Москва', orders: 1, sum_kopecks: 5000 },
    ],
    total_orders: 4,
    no_city_orders: 2,
  });
  // Канал-изоляция: все заказы ch без города → rows пусты, все 8 в no_city_orders.
  assert.deepEqual(await db.getMsGeographyInternal(ch.id, {}), {
    rows: [], total_orders: 8, no_city_orders: 8,
  });
  // limit режет топ ПОСЛЕ сортировки, но total/no_city — по всему окну.
  const limited = await db.getMsGeographyInternal(geoCh.id, { limit: 1 });
  assert.deepEqual(limited.rows.map((r) => r.city), ['Москва']);   // город с макс. суммой
  assert.equal(limited.total_orders, 6);
  assert.equal(limited.no_city_orders, 2);
});

test('ForActor (слайс 6): владелец видит канал/гео geoCh, чужой — пусто/нулевой объект', { skip }, async () => {
  assert.equal((await db.getMsSalesByChannelForActor(geoCh.id, { uid: owner.id }, {})).length, 3, 'владелец видит каналы продаж');
  const geo = await db.getMsGeographyForActor(geoCh.id, { uid: owner.id }, {});
  assert.equal(geo.rows.length, 2, 'владелец видит города');
  assert.equal(geo.total_orders, 6);

  assert.deepEqual(await db.getMsSalesByChannelForActor(geoCh.id, { uid: stranger.id }, {}), [], 'чужой → [] (каналы)');
  assert.deepEqual(
    await db.getMsGeographyForActor(geoCh.id, { uid: stranger.id }, {}),
    { rows: [], total_orders: 0, no_city_orders: 0 },
    'чужой → нулевой объект (гео), той же формы что Internal',
  );
});

test('channel-series (слайс 6в): дневная серия, фильтр по каналу, окно', { skip }, async () => {
  // Все каналы: 6 заказов geoCh на 6 разных дней → 6 точек, каждая orders=1.
  const all = await db.getMsChannelSeriesInternal(geoCh.id, {});
  assert.equal(all.length, 6);
  assert.deepEqual(all[0], { day: '2026-01-10', orders: 1, sum_kopecks: 100000 });
  // Фильтр по SC_SITE: только g1+g2.
  assert.deepEqual(await db.getMsChannelSeriesInternal(geoCh.id, { salesChannelId: SC_SITE }), [
    { day: '2026-01-10', orders: 1, sum_kopecks: 100000 },
    { day: '2026-01-15', orders: 1, sum_kopecks: 50000 },
  ]);
  // Окно sinceDay режет; фильтр по каналу + окно вместе.
  assert.deepEqual(await db.getMsChannelSeriesInternal(geoCh.id, { salesChannelId: SC_DIRECT, sinceDay: '2026-02-15' }), [
    { day: '2026-02-20', orders: 1, sum_kopecks: 20000 },
  ]);
  // Чужой actor → пусто.
  assert.deepEqual(await db.getMsChannelSeriesForActor(geoCh.id, { uid: stranger.id }, {}), []);
});

test('channel-series: multi-channel aggregate, inclusive end day and grouped breakdown', { skip }, async () => {
  const aggregate = await db.getMsChannelSeriesInternal(geoCh.id, {
    salesChannelIds: [SC_SITE, SC_DIRECT],
    sinceDay: '2026-01-15',
    untilDay: '2026-02-10',
  });
  assert.deepEqual(aggregate, [
    { day: '2026-01-15', orders: 1, sum_kopecks: 50000 },
    { day: '2026-02-10', orders: 1, sum_kopecks: 30000 },
  ], 'both selected channels are aggregated and the end day is inclusive');

  const grouped = await db.getMsChannelSeriesGroupedInternal(geoCh.id, {
    salesChannelIds: [SC_SITE, SC_DIRECT],
    sinceDay: '2026-01-15',
    untilDay: '2026-02-10',
  });
  assert.deepEqual(grouped, [
    { sales_channel_id: SC_DIRECT, day: '2026-02-10', orders: 1, sum_kopecks: 30000 },
    { sales_channel_id: SC_SITE, day: '2026-01-15', orders: 1, sum_kopecks: 50000 },
  ], 'breakdown preserves a separate series identity for every selected channel');

  assert.deepEqual(
    await db.getMsChannelSeriesGroupedForActor(geoCh.id, { uid: stranger.id }, {
      salesChannelIds: [SC_SITE, SC_DIRECT],
    }),
    [],
    'grouped series remain actor-gated',
  );
});

test('ForActor: владелец видит агрегаты, чужой actor — пусто (репо гейтит доступ сам)', { skip }, async () => {
  assert.equal((await db.getMsFunnelForActor(ch.id, { uid: owner.id }, {})).length, 3, 'владелец видит структуру статусов');
  assert.equal((await db.getMsCustomersForActor(ch.id, { uid: owner.id }, {})).summary.customers, 3, 'владелец видит клиентов');
  assert.equal((await db.getMsCohortsForActor(ch.id, { uid: owner.id })).length, 3, 'владелец видит когорты');
  assert.equal((await db.getMsTopCustomersForActor(ch.id, { uid: owner.id }, {})).length, 3, 'владелец видит топ клиентов');
  assert.equal(await db.getMsOldestOrderDayForActor(ch.id, { uid: owner.id }), '2026-01-02', 'владелец видит старейший день');

  assert.deepEqual(await db.getMsFunnelForActor(ch.id, { uid: stranger.id }, {}), [], 'чужой → [] (структура статусов)');
  assert.equal(await db.getMsCustomersForActor(ch.id, { uid: stranger.id }, {}), null, 'чужой → null (клиенты)');
  assert.deepEqual(await db.getMsCohortsForActor(ch.id, { uid: stranger.id }), [], 'чужой → [] (когорты)');
  assert.deepEqual(await db.getMsTopCustomersForActor(ch.id, { uid: stranger.id }, {}), [], 'чужой → [] (топ клиентов)');
  assert.equal(await db.getMsOldestOrderDayForActor(ch.id, { uid: stranger.id }), null, 'чужой → null (старейший день)');
});
