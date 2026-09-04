'use strict';

// Integration-тесты чтения архива СДЭК на РЕАЛЬНОМ Postgres. Вся содержательная часть этих
// эндпоинтов — SQL, и ошибиться в нём можно тихо: окно, съехавшее на час из-за часового пояса,
// или отмена, попавшая в выручку, не падают, а просто показывают неправильное число.
// Без TEST_DATABASE_URL всё SKIP:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
const nonce = `cdekread${Date.now().toString(36)}${process.pid}`;
let seq = 0;

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  await db.migrate();
});

test.after(async () => {
  if (db) await db.close();
});

/** Источник с наполненным архивом. orders — короткая запись: [id, день, сумма ₽, статус, канал]. */
async function seed(orders, { tz = 'Europe/Moscow', products = [] } = {}) {
  const user = await db.createUser({
    email: `read.${seq++}.${nonce}@it.local`, pass_hash: 'x', role: 'user', status: 'active',
  });
  const channel = await db.createCdekChannel({ owner_uid: user.id, name: 'Склад' });
  await db.saveCdekSource(channel.id, { tz, title: 'Склад' });
  const importId = await db.startCdekImport({
    channel_id: channel.id, uploaded_by: user.id, filename: 'a.xlsx', file_sha256: `${nonce}${seq++}`,
  });
  await db.applyCdekImport({
    channelId: channel.id,
    importId,
    tz,
    orders: orders.map(([id, created, rub, status = 'complete', channelKey = 'own', productId = 'p1', kind = 'sale']) => ({
      order_id: String(id),
      created,
      status,
      carrier: 'Cdek',
      channel: channelKey,
      external_order_id: null,
      track_number: null,
      warehouse_code: '19821',
      comment: null,
      kind,
      items: [{ product_id: productId, unit_price_kopecks: Math.round(rub * 100), qty: 1, qty_reserved: 1 }],
    })),
    products,
  });
  // Актор — форма req.user ({ uid, role }), а не строка users: ownership-чек читает именно uid.
  return { user, actor: { uid: user.id, role: 'user' }, channelId: channel.id, importId };
}

const W = (from, to, prevFrom, prevTo) => ({ from, to, prevFrom, prevTo, tz: 'Europe/Moscow' });

test('итоги: выручка окна и равного предыдущего в одном ответе', { skip }, async () => {
  const { channelId, actor } = await seed([
    [1, '2026-03-05 10:00:00', 1000],
    [2, '2026-03-06 10:00:00', 2000],
    [3, '2026-02-25 10:00:00', 500],   // предыдущее окно
    [4, '2026-01-01 10:00:00', 9999],  // вне обоих окон
  ]);
  const r = await db.getCdekSummaryForActor(channelId, actor, W('2026-03-01', '2026-03-31', '2026-01-29', '2026-02-28'));
  assert.equal(Number(r.current.revenue_kopecks), 300000);
  assert.equal(Number(r.current.orders), 2);
  assert.equal(Number(r.previous.revenue_kopecks), 50000);
  assert.equal(Number(r.previous.orders), 1);
});

test('отмены не в выручке, но считаются в общем числе заказов и в доле отмен', { skip }, async () => {
  const { channelId, actor } = await seed([
    [1, '2026-03-05 10:00:00', 1000],
    [2, '2026-03-06 10:00:00', 2000, 'delivery'],
    [3, '2026-03-07 10:00:00', 5000, 'cancel'],
    [4, '2026-03-08 10:00:00', 700, 'return'],
  ]);
  const r = await db.getCdekSummaryForActor(channelId, actor, W('2026-03-01', '2026-03-31', null, null));
  // Владелец решил: delivery — уже выручка; вычитаются только отмены и возвраты.
  assert.equal(Number(r.current.revenue_kopecks), 300000);
  assert.equal(Number(r.current.orders), 2);
  assert.equal(Number(r.current.orders_all), 4);
  assert.equal(Number(r.current.orders_cancelled), 1);
  assert.equal(Number(r.current.orders_returned), 1);
});

test('режим «только завершённые» отсекает и delivery', { skip }, async () => {
  const { channelId, actor } = await seed([
    [1, '2026-03-05 10:00:00', 1000],
    [2, '2026-03-06 10:00:00', 2000, 'delivery'],
  ]);
  const opts = { ...W('2026-03-01', '2026-03-31', null, null), include: 'completed' };
  const r = await db.getCdekSummaryForActor(channelId, actor, opts);
  assert.equal(Number(r.current.revenue_kopecks), 100000);
});

test('складские движения не видны ни в одном режиме — это не продажи', { skip }, async () => {
  const { channelId, actor } = await seed([
    [1, '2026-03-05 10:00:00', 1000],
    [2, '2026-03-06 10:00:00', 37500, 'complete', 'own', 'p1', 'stock_move'],
  ]);
  for (const include of ['revenue', 'completed', 'all']) {
    const r = await db.getCdekSummaryForActor(channelId, actor, { ...W('2026-03-01', '2026-03-31', null, null), include });
    assert.equal(Number(r.current.revenue_kopecks), 100000, `include=${include}`);
  }
});

test('граница окна — в зоне ИСТОЧНИКА, а не в UTC сервера', { skip }, async () => {
  // 23:30 по Москве это 20:30 UTC того же дня, а 00:30 следующего — 21:30 UTC предыдущего.
  // Считай мы окно в UTC, первый заказ выпал бы из своего дня, а второй попал бы в чужой.
  const { channelId, actor } = await seed([
    [1, '2026-01-10 23:30:00', 1000],
    [2, '2026-01-11 00:30:00', 2000],
  ]);
  const r = await db.getCdekSummaryForActor(channelId, actor, W('2026-01-10', '2026-01-10', null, null));
  assert.equal(Number(r.current.orders), 1);
  assert.equal(Number(r.current.revenue_kopecks), 100000);
});

test('ряд: дни, недели и месяцы группируются в зоне источника', { skip }, async () => {
  const { channelId, actor } = await seed([
    [1, '2026-03-02 10:00:00', 100],  // понедельник
    [2, '2026-03-03 10:00:00', 200],  // вторник той же недели
    [3, '2026-03-09 10:00:00', 400],  // следующий понедельник
  ]);
  const win = W('2026-03-01', '2026-03-31', null, null);
  const byDay = await db.getCdekSeriesForActor(channelId, actor, { ...win, grain: 'day' });
  assert.deepEqual(byDay.current.map((r) => r.day), ['2026-03-02', '2026-03-03', '2026-03-09']);

  const byWeek = await db.getCdekSeriesForActor(channelId, actor, { ...win, grain: 'week' });
  assert.deepEqual(byWeek.current.map((r) => [r.day, Number(r.revenue_kopecks)]),
    [['2026-03-02', 30000], ['2026-03-09', 40000]], 'неделя начинается с понедельника');

  const byMonth = await db.getCdekSeriesForActor(channelId, actor, { ...win, grain: 'month' });
  assert.equal(byMonth.current.length, 1);
  assert.equal(Number(byMonth.current[0].revenue_kopecks), 70000);
});

test('ряд не достраивает пустые дни — плотную сетку рисует фронт', { skip }, async () => {
  const { channelId, actor } = await seed([[1, '2026-03-05 10:00:00', 100]]);
  const s = await db.getCdekSeriesForActor(channelId, actor, { ...W('2026-03-01', '2026-03-31', null, null), grain: 'day' });
  assert.equal(s.current.length, 1, 'корзина одна, а не 31');
});

test('разрез по каналам несёт величины прошлого окна в тех же строках', { skip }, async () => {
  const { channelId, actor } = await seed([
    [1, '2026-03-05 10:00:00', 1000, 'complete', 'own'],
    [2, '2026-03-06 10:00:00', 300, 'complete', 'wildberries'],
    [3, '2026-02-10 10:00:00', 500, 'complete', 'own'],
  ]);
  const rows = await db.getCdekBreakdownForActor(channelId, actor,
    { ...W('2026-03-01', '2026-03-31', '2026-01-30', '2026-02-28'), dim: 'channel' });
  const own = rows.find((r) => r.key === 'own');
  assert.equal(Number(own.revenue_kopecks), 100000);
  assert.equal(Number(own.prev_revenue_kopecks), 50000);
  const wb = rows.find((r) => r.key === 'wildberries');
  assert.equal(Number(wb.prev_revenue_kopecks), 0, 'канала не было в прошлом окне — честный ноль');
  assert.equal(rows[0].key, 'own', 'сортировка по выручке текущего окна');
});

test('разрез по статусам с include=all показывает и отменённые', { skip }, async () => {
  // Иначе разбивка ПО статусам показала бы только те статусы, которые сама и отобрала.
  const { channelId, actor } = await seed([
    [1, '2026-03-05 10:00:00', 1000],
    [2, '2026-03-06 10:00:00', 5000, 'cancel'],
  ]);
  const rows = await db.getCdekBreakdownForActor(channelId, actor,
    { ...W('2026-03-01', '2026-03-31', null, null), dim: 'status', include: 'all' });
  assert.deepEqual(rows.map((r) => r.key).sort(), ['cancel', 'complete']);
});

test('разрез по товарам подтягивает название из справочника', { skip }, async () => {
  const { channelId, actor } = await seed(
    [[1, '2026-03-05 10:00:00', 1000, 'complete', 'own', 'p7']],
    { products: [{ product_id: 'p7', title: 'Чехол для ноутбука', article: 'CS-O14', sku: 'CS-O14', barcodes: [] }] },
  );
  const rows = await db.getCdekBreakdownForActor(channelId, actor,
    { ...W('2026-03-01', '2026-03-31', null, null), dim: 'product' });
  assert.equal(rows[0].key, 'p7');
  assert.equal(rows[0].title, 'Чехол для ноутбука');
  assert.equal(rows[0].article, 'CS-O14');
});

test('пустой канал остаётся пустым ключом, а не превращается в категорию', { skip }, async () => {
  const { channelId, actor } = await seed([[1, '2026-03-05 10:00:00', 1000, 'complete', null]]);
  const rows = await db.getCdekBreakdownForActor(channelId, actor,
    { ...W('2026-03-01', '2026-03-31', null, null), dim: 'channel' });
  assert.equal(rows[0].key, '');
});

test('покрытие отличает «ноль заказов» от «день не залит»', { skip }, async () => {
  // Без этого различия 61 день года без заказов читается как провал продаж, хотя это дыра
  // в загрузке.
  const { channelId, actor, importId } = await seed([
    [1, '2026-03-05 10:00:00', 1000],
    [2, '2026-03-07 10:00:00', 2000],
  ]);
  await db.finishCdekImport(channelId, importId, {
    stats: { rows_total: 2, rows_rejected: 0, orders_total: 2, period_from: '2026-03-05', period_to: '2026-03-07' },
  });

  const days = await db.getCdekCoverageForActor(channelId, actor, { from: '2026-03-03', to: '2026-03-09', tz: 'Europe/Moscow' });
  const at = (day) => days.find((d) => d.day === day);
  assert.equal(at('2026-03-03').covered, false, 'до загруженного периода — данных нет');
  assert.equal(at('2026-03-05').covered, true);
  assert.equal(Number(at('2026-03-06').revenue_kopecks), 0);
  assert.equal(at('2026-03-06').covered, true, 'внутри периода ноль заказов — это настоящий ноль');
  assert.equal(at('2026-03-09').covered, false);
  assert.equal(Number(at('2026-03-05').revenue_kopecks), 100000);
});

test('незавершённый импорт не считается покрытием', { skip }, async () => {
  const { channelId, actor } = await seed([[1, '2026-03-05 10:00:00', 1000]]);
  const days = await db.getCdekCoverageForActor(channelId, actor, { from: '2026-03-05', to: '2026-03-05', tz: 'Europe/Moscow' });
  assert.equal(days[0].covered, false, 'pending-строка импорта покрытием не является');
  assert.equal(Number(days[0].revenue_kopecks), 100000, 'но заказы из него уже видны');
});

test('границы архива подписывают «Всё»', { skip }, async () => {
  const { channelId, actor } = await seed([
    [1, '2025-07-31 15:39:48', 1000],
    [2, '2026-07-30 17:09:09', 2000],
  ]);
  const bounds = await db.getCdekBoundsForActor(channelId, actor);
  assert.equal(bounds.first_day, '2025-07-31');
  assert.equal(bounds.last_day, '2026-07-30');
  assert.equal(bounds.orders, 2);
});

test('чужой актор не читает архив ни одним из ридеров', { skip }, async () => {
  const { channelId } = await seed([[1, '2026-03-05 10:00:00', 1000]]);
  const stranger = await db.createUser({
    email: `stranger.${seq++}.${nonce}@it.local`, pass_hash: 'x', role: 'user', status: 'active',
  });
  const actor = { uid: stranger.id, role: 'user' };
  const win = W('2026-03-01', '2026-03-31', null, null);
  assert.equal(await db.getCdekSummaryForActor(channelId, actor, win), null);
  assert.deepEqual((await db.getCdekSeriesForActor(channelId, actor, win)).current, []);
  assert.deepEqual(await db.getCdekBreakdownForActor(channelId, actor, { ...win, dim: 'channel' }), []);
  assert.deepEqual(await db.getCdekCoverageForActor(channelId, actor, { from: '2026-03-01', to: '2026-03-02' }), []);
  assert.equal(await db.getCdekBoundsForActor(channelId, actor), null);
});

test('разрез по товарам несёт разброс цены за штуку, а не только среднюю', { skip }, async () => {
  // У 48 из 54 товаров склада цена плавает (маркетплейсы режут скидку). Средняя это скрывает:
  // «2 400 ₽» одинаково выглядит и у фиксированной цены, и у диапазона 1 818…3 750.
  const { channelId, actor } = await seed([
    [1, '2026-03-05 10:00:00', 1818, 'complete', 'own', 'p1'],
    [2, '2026-03-06 10:00:00', 2450, 'complete', 'own', 'p1'],
    [3, '2026-03-07 10:00:00', 3750, 'complete', 'own', 'p1'],
    [4, '2026-03-08 10:00:00', 2850, 'complete', 'own', 'p2'],
  ]);
  const rows = await db.getCdekBreakdownForActor(channelId, actor,
    { ...W('2026-03-01', '2026-03-31', null, null), dim: 'product' });
  const p1 = rows.find((r) => r.key === 'p1');
  assert.equal(Number(p1.price_min_kopecks), 181800);
  assert.equal(Number(p1.price_max_kopecks), 375000);
  assert.equal(Number(p1.price_median_kopecks), 245000, 'медиана, а не среднее');
  const p2 = rows.find((r) => r.key === 'p2');
  assert.equal(Number(p2.price_min_kopecks), Number(p2.price_max_kopecks), 'одна цена — размаха нет');
});

test('ритм считается по ЗАКАЗАМ, а не по строкам выгрузки', { skip }, async () => {
  // Многострочный заказ оформлен ОДИН раз: попади он в клетку дважды, пик «когда покупают»
  // сдвинулся бы к часам, в которые просто больше позиций в корзине.
  const { channelId, actor, importId } = await seed([]);
  await db.applyCdekImport({
    channelId,
    importId,
    tz: 'Europe/Moscow',
    orders: [{
      order_id: 'multi', created: '2026-03-02 08:30:00', status: 'complete', carrier: 'Cdek',
      channel: 'own', external_order_id: null, track_number: null, warehouse_code: '19821',
      comment: null, kind: 'sale',
      items: [
        { product_id: 'a', unit_price_kopecks: 10000, qty: 1, qty_reserved: 1 },
        { product_id: 'b', unit_price_kopecks: 20000, qty: 1, qty_reserved: 1 },
        { product_id: 'c', unit_price_kopecks: 30000, qty: 1, qty_reserved: 1 },
      ],
    }],
  });
  const cells = await db.getCdekHourlyForActor(channelId, actor, W('2026-03-01', '2026-03-31', null, null));
  assert.equal(cells.length, 1);
  assert.equal(Number(cells[0].weekday), 1, '2 марта 2026 — понедельник');
  assert.equal(Number(cells[0].hour), 8);
  assert.equal(Number(cells[0].orders), 1, 'три позиции — всё ещё один заказ');
});

test('лента заказов ищет по номеру, внешнему номеру и треку', { skip }, async () => {
  const { channelId, actor, importId } = await seed([]);
  await db.applyCdekImport({
    channelId, importId, tz: 'Europe/Moscow',
    orders: [
      { order_id: '33905564', created: '2026-03-05 10:00:00', status: 'complete', carrier: 'Cdek', channel: 'own',
        external_order_id: null, track_number: '10145274548', warehouse_code: '19821', comment: null, kind: 'sale',
        items: [{ product_id: 'p1', unit_price_kopecks: 285000, qty: 1, qty_reserved: 1 }] },
      { order_id: '33905573', created: '2026-03-06 10:00:00', status: 'delivery', carrier: 'YM FBS', channel: 'yandex_market',
        external_order_id: '3692481361', track_number: null, warehouse_code: '19821', comment: null, kind: 'sale',
        items: [{ product_id: 'p2', unit_price_kopecks: 439000, qty: 2, qty_reserved: 2 }] },
    ],
  });
  const win = W('2026-03-01', '2026-03-31', null, null);

  const byTrack = await db.getCdekOrdersForActor(channelId, actor, { ...win, q: '10145274548' });
  assert.equal(byTrack.rows.length, 1);
  assert.equal(byTrack.rows[0].order_id, '33905564');

  const byExternal = await db.getCdekOrdersForActor(channelId, actor, { ...win, q: '369248' });
  assert.equal(byExternal.rows[0].order_id, '33905573');

  // Статусы ленты едут в `include` — своим параметром они ложились ПОВЕРХ канона и давали
  // противоречивый предикат (см. REVENUE_FILTER): «Возврат» при include='revenue' — это «равен
  // return И не равен return», то есть всегда пустая лента.
  const byStatus = await db.getCdekOrdersForActor(channelId, actor, { ...win, include: 'status:delivery' });
  assert.equal(byStatus.rows.length, 1);
  assert.equal(Number(byStatus.rows[0].amount_kopecks), 878000, 'сумма заказа = цена × количество');
  assert.equal(Number(byStatus.rows[0].items), 2);

  // ВНЕ канона: возврат в ленте не виден по умолчанию (он не отгрузка), но ПО ВЫБОРУ обязан
  // находиться. Прежний отдельный параметр статуса давал здесь ноль строк при любом наборе.
  const canon = await db.getCdekOrdersForActor(channelId, actor, { ...win });
  assert.equal(canon.rows.length, 2, 'канон показывает обе отгрузки');

  const byChannel = await db.getCdekOrdersForActor(channelId, actor, { ...win, channel: 'own' });
  assert.equal(byChannel.rows.length, 1);

  const all = await db.getCdekOrdersForActor(channelId, actor, win);
  assert.equal(all.total, 2);
  assert.equal(all.rows[0].order_id, '33905573', 'свежие сверху');
});
