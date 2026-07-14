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
