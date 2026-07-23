'use strict';

// Integration-тесты вертикали Яндекс.Метрики на РЕАЛЬНОМ Postgres (образец
// ms_analytics.integration.test): миграция 033 (ym_accounts / ym_daily / расширение CHECK
// external_sources.network до 'ym'), write-путь db.saveYmAccount/upsertYmDaily, чтение через
// getYmAccount/listYmAccounts/hasYmDaily/getYmDailyAllForActor. saveYmAccount заодно
// доказывает, что ensureExternalSource('ym', …) проходит расширенный constraint — без DO-блока
// миграции первый же connect падал бы на CHECK. Все числа посчитаны руками от фиксированного
// сида; сосед-канал доказывает channel-изоляцию, stranger — ForActor-гейт.
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
const nonce = `ymr${Date.now().toString(36)}${process.pid}`;
const COUNTER_ID = `cnt-${nonce}`;

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
  owner = await db.createUser({ email: `own.${nonce}@it.local`, pass_hash: 'x', role: 'user', status: 'active' });
  stranger = await db.createUser({ email: `str.${nonce}@it.local`, pass_hash: 'x', role: 'user', status: 'active' });

  ch = await db.createYmChannel({ owner_uid: owner.id, name: `Счётчик ${nonce}` });
  other = await db.createYmChannel({ owner_uid: owner.id, name: `Сосед ${nonce}` });

  await db.saveYmAccount(ch.id, {
    counter_id: COUNTER_ID,
    counter_name: 'nōtem',
    site: 'notem.ru',
    counter_created_day: '2024-03-01',
    access_token_enc: 'iv:tag:cipher',
  });

  await db.upsertYmDaily(ch.id, [
    { day: '2026-07-01', visits: 10, users: 7, pageviews: 25 },
    { day: '2026-07-02', visits: 0, users: 0, pageviews: 0 },
    { day: '2026-07-03', visits: 4, users: 3, pageviews: 9 },
  ]);
  // Сосед-канал того же владельца: его строки НЕ должны просачиваться в чтения ch.
  await db.upsertYmDaily(other.id, [{ day: '2026-07-01', visits: 999, users: 999, pageviews: 999 }]);
});

test.after(async () => {
  if (!pool) return;
  // Каналы, ym_accounts и ym_daily уходят каскадом за пользователями (FK ON DELETE CASCADE).
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${nonce}%`]);
  await pool.end();
});

test('createYmChannel: standalone-канал source=ym без платформенной идентичности', { skip }, async () => {
  assert.equal(ch.source, 'ym');
  assert.equal(ch.username, null);
  assert.equal(ch.title, `Счётчик ${nonce}`);
});

test('saveYmAccount: canonical ym-source прошёл расширенный CHECK и штампован на учётку и канал', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT es.network, es.external_id, es.title, es.username
       FROM ym_accounts ya JOIN external_sources es ON es.id = ya.source_id
      WHERE ya.channel_id=$1`, [ch.id]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { network: 'ym', external_id: COUNTER_ID, title: 'nōtem', username: 'notem.ru' });
  const { rows: chRows } = await pool.query('SELECT source_id FROM channels WHERE id=$1', [ch.id]);
  assert.ok(chRows[0].source_id != null, 'standalone ym-канал получил канонический source_id');
});

test('getYmAccount: полная строка учётки, токен — тем же шифроблобом, каким пришёл', { skip }, async () => {
  const acc = await db.getYmAccount(ch.id);
  assert.equal(acc.counter_id, COUNTER_ID);
  assert.equal(acc.counter_name, 'nōtem');
  assert.equal(acc.site, 'notem.ru');
  assert.equal(acc.counter_created_day, '2024-03-01');
  assert.equal(acc.access_token_enc, 'iv:tag:cipher');
});

test('findYmChannelByCounter: дедуп повторного connect (владелец находит, чужой — нет)', { skip }, async () => {
  assert.equal(await db.findYmChannelByCounter(owner.id, COUNTER_ID), ch.id);
  assert.equal(await db.findYmChannelByCounter(stranger.id, COUNTER_ID), null);
});

test('listYmAccounts: живые каналы в списке, disabled — исключён (квота не тратится впустую)', { skip }, async () => {
  const before = await db.listYmAccounts();
  assert.ok(before.some((a) => a.channel_id === ch.id && a.counter_id === COUNTER_ID));
  await pool.query(`UPDATE channels SET status='disabled' WHERE id=$1`, [ch.id]);
  try {
    const after = await db.listYmAccounts();
    assert.ok(!after.some((a) => a.channel_id === ch.id), 'disabled-канал выпал из прохода крона');
  } finally {
    await pool.query(`UPDATE channels SET status='active' WHERE id=$1`, [ch.id]);
  }
});

test('upsertYmDaily: повторный проход ЗАМЕНЯЕТ точку (допересчёт Метрики вниз доносится честно)', { skip }, async () => {
  await db.upsertYmDaily(ch.id, [{ day: '2026-07-01', visits: 8, users: 6, pageviews: 20 }]);
  const rows = await db.getYmDailyAllForActor(ch.id, { uid: owner.id });
  assert.deepEqual(rows[0], { day: '2026-07-01', visits: 8, users: 6, pageviews: 20 });
});

test('hasYmDaily: дешёвый EXISTS для решения «бэкфилл или окно»', { skip }, async () => {
  assert.equal(await db.hasYmDaily(ch.id), true);
  const empty = await db.createYmChannel({ owner_uid: owner.id, name: `Пустой ${nonce}` });
  assert.equal(await db.hasYmDaily(empty.id), false);
});

test('getYmDailyAllForActor: day ASC, числа числами, только свой канал; чужому — []', { skip }, async () => {
  const rows = await db.getYmDailyAllForActor(ch.id, { uid: owner.id });
  assert.deepEqual(rows.map((r) => r.day), ['2026-07-01', '2026-07-02', '2026-07-03']);
  assert.deepEqual(rows[2], { day: '2026-07-03', visits: 4, users: 3, pageviews: 9 });
  assert.equal(typeof rows[2].visits, 'number', 'bigint пришёл числом, не строкой pg');
  // Нулевой день архива — честный 0 (плотное окно), а не дыра.
  assert.deepEqual(rows[1], { day: '2026-07-02', visits: 0, users: 0, pageviews: 0 });
  assert.deepEqual(await db.getYmDailyAllForActor(ch.id, { uid: stranger.id }), []);
});

test('deleteYmAccount: сносится ТОЛЬКО учётка, архив ym_daily живёт дальше', { skip }, async () => {
  assert.equal(await db.deleteYmAccount(other.id), false, 'у соседа учётки не было — идемпотентный false');
  assert.equal(await db.deleteYmAccount(ch.id), true);
  assert.equal(await db.getYmAccount(ch.id), null);
  const rows = await db.getYmDailyAllForActor(ch.id, { uid: owner.id });
  assert.equal(rows.length, 3, 'история пережила отключение источника');
});
