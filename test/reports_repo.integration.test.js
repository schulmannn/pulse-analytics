'use strict';

// Integration-тесты reportsRepo («Отчёты») — на РЕАЛЬНОМ Postgres. Без TEST_DATABASE_URL всё
// SKIP'ается (как users/channels/campaigns). Локальный стенд:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test
// Проверяем: create со schedule и без; безопасную JSONB-экстракцию summary-полей для мусорного/
// legacy config (никогда не падает); ownership (чужой uid не видит и не читает отчёт).

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `rep${Date.now().toString(36)}${process.pid}`;
const mail = (tag) => `${tag}.${nonce}@it.local`;
const S = {};

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
  // Idempotent — ensures the local stand has 019 (report delivery reservation columns) before the
  // reservation regression below, without depending on the harness's migrate ordering.
  const { runMigrations } = require('../server/migrations.js');
  await runMigrations(pool, { log: () => {} });
  S.userA = await db.createUser({ email: mail('a'), pass_hash: 'x', role: 'user', status: 'active' });
  S.userB = await db.createUser({ email: mail('b'), pass_hash: 'x', role: 'user', status: 'active' });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.end();
});

test('createReport: schedule опционален и безопасен (default none, невалидный отклоняется)', { skip }, async () => {
  const plain = await db.createReport(S.userA.id, 'Без доставки', { blocks: [] });
  assert.strictEqual(plain.schedule, 'none');

  const weekly = await db.createReport(S.userA.id, 'С доставкой', { blocks: [] }, 'weekly');
  assert.strictEqual(weekly.schedule, 'weekly');

  await assert.rejects(
    () => db.createReport(S.userA.id, 'Мусор', { blocks: [] }, 'daily'),
    /bad schedule/,
  );
});

test('listReports: summary-поля безопасно извлекаются из JSONB', { skip }, async () => {
  const good = await db.createReport(
    S.userA.id,
    'Полный',
    { blocks: ['week', 'kpi-summary', 'top-posts'], periodDays: 7, channelId: 4242 },
    'monthly',
  );
  const garbage = await db.createReport(
    S.userA.id,
    'Мусорный config',
    { blocks: 'не массив', periodDays: 'позавчера', channelId: { nested: true } },
  );
  const emptyCfg = await db.createReport(S.userA.id, 'Пустой config', {});
  const hugeNumeric = await db.createReport(
    S.userA.id,
    'Большие числа',
    { blocks: [], periodDays: 1e100, channelId: 2147483648 },
  );

  const rows = await db.listReports(S.userA.id);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const g = byId.get(good.id);
  assert.strictEqual(g.block_count, 3);
  assert.strictEqual(g.period_days, 7);
  assert.strictEqual(g.channel_id, 4242);
  assert.strictEqual(g.schedule, 'monthly');
  assert.ok('last_sent_at' in g);

  // Мусор → все summary-поля NULL, запрос не падает.
  const bad = byId.get(garbage.id);
  assert.strictEqual(bad.block_count, null);
  assert.strictEqual(bad.period_days, null);
  assert.strictEqual(bad.channel_id, null);

  const empty = byId.get(emptyCfg.id);
  assert.strictEqual(empty.block_count, null);
  assert.strictEqual(empty.period_days, null);
  assert.strictEqual(empty.channel_id, null);

  const huge = byId.get(hugeNumeric.id);
  assert.strictEqual(huge.period_days, null, 'неизвестный период не становится summary');
  assert.strictEqual(huge.channel_id, null, 'numeric за int4 не роняет list query');
});

test('reserve/clear delivery: атомарная at-most-once резервация периода (019)', { skip }, async () => {
  const rep = await db.createReport(S.userA.id, 'Доставка', { blocks: [] }, 'weekly');
  const P1 = '2026-W29';
  const P2 = '2026-W30';

  // Первый claim периода — успех; повторный claim ТОГО ЖЕ периода — отказ (нет двойной отправки).
  assert.strictEqual(await db.reserveReportDelivery(rep.id, P1), true, 'первый claim периода');
  assert.strictEqual(await db.reserveReportDelivery(rep.id, P1), false, 'тот же период не резервируется дважды');

  // Столбцы проставлены (внутренние, не в публичном REPORT_COLS).
  const seen = await pool.query(
    'SELECT last_delivery_period, last_delivery_attempt_at FROM reports WHERE id=$1', [rep.id]);
  assert.strictEqual(seen.rows[0].last_delivery_period, P1);
  assert.ok(seen.rows[0].last_delivery_attempt_at, 'timestamp резервации проставлен');

  // Новый период перезаписывает более старую резервацию.
  assert.strictEqual(await db.reserveReportDelivery(rep.id, P2), true, 'новый период перезаписывает старый');
  assert.strictEqual(
    (await pool.query('SELECT last_delivery_period FROM reports WHERE id=$1', [rep.id])).rows[0].last_delivery_period,
    P2);

  // Clear только при точном совпадении периода: устаревший период не чистит текущую резервацию.
  assert.strictEqual(await db.clearReportDelivery(rep.id, P1), false, 'clear устаревшего периода — no-op');
  assert.strictEqual(
    (await pool.query('SELECT last_delivery_period FROM reports WHERE id=$1', [rep.id])).rows[0].last_delivery_period,
    P2, 'резервация P2 не тронута');

  // Точный clear освобождает; после него период снова резервируется.
  assert.strictEqual(await db.clearReportDelivery(rep.id, P2), true, 'точный clear освобождает');
  assert.strictEqual(
    (await pool.query('SELECT last_delivery_period FROM reports WHERE id=$1', [rep.id])).rows[0].last_delivery_period,
    null);
  assert.strictEqual(await db.reserveReportDelivery(rep.id, P2), true, 'после clear период снова свободен');
});

test('ownership: чужой uid не видит и не читает отчёт', { skip }, async () => {
  const mine = await db.createReport(S.userA.id, 'Приватный', { blocks: [] });

  const bList = await db.listReports(S.userB.id);
  assert.ok(!bList.some((r) => r.id === mine.id), 'B не видит отчёт A в списке');

  const bRead = await db.getReport(S.userB.id, mine.id);
  assert.strictEqual(bRead, null, 'B не читает отчёт A напрямую');

  const bUpdate = await db.updateReport(S.userB.id, mine.id, { name: 'взлом' });
  assert.strictEqual(bUpdate, null, 'B не обновляет отчёт A');

  const bDelete = await db.deleteReport(S.userB.id, mine.id);
  assert.strictEqual(bDelete, false, 'B не удаляет отчёт A');

  // A всё ещё владеет отчётом.
  const aRead = await db.getReport(S.userA.id, mine.id);
  assert.ok(aRead && aRead.name === 'Приватный');
});
