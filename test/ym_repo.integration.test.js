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
    {
      day: '2026-07-01',
      visits: 10,
      users: 7,
      pageviews: 25,
      bounce_rate: 31.25,
      avg_visit_duration_seconds: 84.5,
      page_depth: 2.5,
      new_users: 5,
      percent_new_visitors: 71.43,
      robot_visits: 2,
      robot_percentage: 20,
    },
    {
      day: '2026-07-02',
      visits: 0,
      users: 0,
      pageviews: 0,
      bounce_rate: null,
      avg_visit_duration_seconds: null,
      page_depth: null,
      new_users: 0,
      percent_new_visitors: null,
      robot_visits: 0,
      robot_percentage: null,
    },
    {
      day: '2026-07-03',
      visits: 4,
      users: 3,
      pageviews: 9,
      bounce_rate: 12.5,
      avg_visit_duration_seconds: 63.2,
      page_depth: 2.25,
      new_users: 1,
      percent_new_visitors: 33.33,
      robot_visits: 0,
      robot_percentage: 0,
    },
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

test('quality backfill marker: guarded по channel+counter и идемпотентен', { skip }, async () => {
  const wrong = await db.markYmQualityBackfilled(ch.id, `wrong-${COUNTER_ID}`);
  assert.equal(wrong, false, 'чужой counter_id не может пометить учётку');
  const before = (await db.listYmAccounts()).find((a) => a.channel_id === ch.id);
  assert.equal(before.quality_backfilled_at, null);

  assert.equal(await db.markYmQualityBackfilled(ch.id, COUNTER_ID), true);
  const marked = (await db.listYmAccounts()).find((a) => a.channel_id === ch.id);
  assert.match(marked.quality_backfilled_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await db.markYmQualityBackfilled(ch.id, COUNTER_ID), false, 'повтор не передёргивает timestamp');
});

test('saveYmAccount: тот же counter сохраняет marker, другой counter сбрасывает его', { skip }, async () => {
  const rotated = await db.createYmChannel({ owner_uid: owner.id, name: `Rotate ${nonce}` });
  const firstCounter = `rotate-a-${nonce}`;
  const secondCounter = `rotate-b-${nonce}`;
  const save = (counter_id, access_token_enc) => db.saveYmAccount(rotated.id, {
    counter_id,
    counter_name: counter_id,
    site: 'rotate.test',
    counter_created_day: '2025-01-01',
    access_token_enc,
  });

  await save(firstCounter, 'enc-a');
  assert.equal(await db.markYmQualityBackfilled(rotated.id, firstCounter), true);
  await save(firstCounter, 'enc-a2');
  let account = (await db.listYmAccounts()).find((a) => a.channel_id === rotated.id);
  assert.ok(account.quality_backfilled_at, 'ротация токена того же счётчика сохраняет завершённый backfill');

  await save(secondCounter, 'enc-b');
  account = (await db.listYmAccounts()).find((a) => a.channel_id === rotated.id);
  assert.equal(account.quality_backfilled_at, null, 'новый счётчик требует собственный полный backfill');
});

test('upsertYmDaily: повторный проход ЗАМЕНЯЕТ точку (допересчёт Метрики вниз доносится честно)', { skip }, async () => {
  await db.upsertYmDaily(ch.id, [{
    day: '2026-07-01',
    visits: 8,
    users: 6,
    pageviews: 20,
    bounce_rate: 22.2,
    avg_visit_duration_seconds: 70.1,
    page_depth: 2.1,
    new_users: 4,
    percent_new_visitors: 66.67,
    robot_visits: 1,
    robot_percentage: 12.5,
  }]);
  const rows = await db.getYmDailyAllForActor(ch.id, { uid: owner.id });
  assert.deepEqual(rows[0], {
    day: '2026-07-01',
    visits: 8,
    users: 6,
    pageviews: 20,
    bounce_rate: 22.2,
    avg_visit_duration_seconds: 70.1,
    page_depth: 2.1,
    new_users: 4,
    percent_new_visitors: 66.67,
    robot_visits: 1,
    robot_percentage: 12.5,
  });
});

test('hasYmDaily: дешёвый EXISTS для решения «бэкфилл или окно»', { skip }, async () => {
  assert.equal(await db.hasYmDaily(ch.id), true);
  const empty = await db.createYmChannel({ owner_uid: owner.id, name: `Пустой ${nonce}` });
  assert.equal(await db.hasYmDaily(empty.id), false);
});

test('getYmDailyAllForActor: day ASC, числа числами, только свой канал; чужому — []', { skip }, async () => {
  const rows = await db.getYmDailyAllForActor(ch.id, { uid: owner.id });
  assert.deepEqual(rows.map((r) => r.day), ['2026-07-01', '2026-07-02', '2026-07-03']);
  assert.deepEqual(rows[2], {
    day: '2026-07-03',
    visits: 4,
    users: 3,
    pageviews: 9,
    bounce_rate: 12.5,
    avg_visit_duration_seconds: 63.2,
    page_depth: 2.25,
    new_users: 1,
    percent_new_visitors: 33.33,
    robot_visits: 0,
    robot_percentage: 0,
  });
  assert.equal(typeof rows[2].visits, 'number', 'bigint пришёл числом, не строкой pg');
  // Нулевой день архива — честный 0 (плотное окно), а не дыра.
  assert.deepEqual(rows[1], {
    day: '2026-07-02',
    visits: 0,
    users: 0,
    pageviews: 0,
    bounce_rate: null,
    avg_visit_duration_seconds: null,
    page_depth: null,
    new_users: 0,
    percent_new_visitors: null,
    robot_visits: 0,
    robot_percentage: null,
  });
  assert.deepEqual(await db.getYmDailyAllForActor(ch.id, { uid: stranger.id }), []);
});

test('deleteYmAccount: сносится ТОЛЬКО учётка, архив ym_daily живёт дальше', { skip }, async () => {
  assert.equal(await db.deleteYmAccount(other.id), false, 'у соседа учётки не было — идемпотентный false');
  assert.equal(await db.deleteYmAccount(ch.id), true);
  assert.equal(await db.getYmAccount(ch.id), null);
  const rows = await db.getYmDailyAllForActor(ch.id, { uid: owner.id });
  assert.equal(rows.length, 3, 'история пережила отключение источника');
});
