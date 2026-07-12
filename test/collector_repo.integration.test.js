'use strict';

// Integration-тесты collectorRepo (P2 db-split PR 7) — на РЕАЛЬНОМ Postgres. Приём/запись данных
// collector'а: ИДЕМПОТЕНТНОСТЬ (повтор ingest_id безопасен, конфликт payload → ошибка), COALESCE-
// upsert (NULL не затирает), pure graphsToDailyRows, persist-бандлы, ретеншн. Без TEST_DATABASE_URL SKIP.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `col${Date.now().toString(36)}${process.pid}`;
let seq = 0;
const mail = (tag) => `${tag}.${seq++}.${nonce}@it.local`;
let ingSeq = 0;
const ingId = () => `ing.${nonce}.${ingSeq++}`;
const today = new Date().toISOString().slice(0, 10);

const mkUser = (tag) => db.createUser({ email: mail(tag), pass_hash: 'x', role: 'user', status: 'active' });
const mkChannel = async (tag) => {
  const u = await mkUser(tag);
  return db.createChannel({ owner_uid: u.id, username: `c.${tag}.${nonce}` });
};

test.before(() => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.PGSSL = process.env.PGSSL || 'disable';
  db = require('../server/db.js');
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  // users каскадят channels → channel_daily/posts/velocity/snapshots/ingest_receipts/collector_status/
  // raw_snapshots/ig_daily/mentions. Чистим mentions по owner заранее (на случай отсутствия каскада).
  await pool.query(`DELETE FROM mentions WHERE owner_channel_id IN (SELECT id FROM channels WHERE owner_uid IN (SELECT id FROM users WHERE email LIKE $1))`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.end();
});

test('graphsToDailyRows (pure): union дней, num-clamp; недоступные графы → []', { skip }, () => {
  assert.deepStrictEqual(db.graphsToDailyRows(null), []);
  assert.deepStrictEqual(db.graphsToDailyRows({ available: false }), []);
  const rows = db.graphsToDailyRows({
    available: true,
    growth: { x: [Date.parse('2026-01-01'), Date.parse('2026-01-02')], series: [{ name: 'subs', values: [100, 110] }] },
    interactions: { x: [Date.parse('2026-01-02')], series: [{ name: 'views', values: [5000] }, { name: 'shares', values: [12] }] },
  });
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r]));
  assert.strictEqual(rows.length, 2, 'union из двух дней');
  assert.strictEqual(byDay['2026-01-01'].subscribers, 100);
  assert.strictEqual(byDay['2026-01-02'].subscribers, 110);
  assert.strictEqual(byDay['2026-01-02'].views, 5000);
  assert.strictEqual(byDay['2026-01-02'].forwards, 12);
});

test('ingestCollectorPayload: первый пишет всё; повтор (тот же id+hash) → {duplicate:true} без двойной записи', { skip }, async () => {
  const ch = await mkChannel('ing');
  const meta = { ingest_id: ingId(), schema_version: '1', collector_version: '1.0', collected_at: new Date().toISOString(), payload_hash: 'h1' };
  const data = {
    snapshot: { subs: 100 },
    dailyRows: [{ day: today, subscribers: 100, joins: 5, leaves: 1, views: 200, forwards: 3, reactions: 7 }],
    postRows: [], mentions: [], velocity: { available: true, p50: 1.2 }, tgChannelId: null,
  };
  const r1 = await db.ingestCollectorPayload(ch.id, meta, data);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.channel_daily, 1);
  assert.strictEqual(r1.velocity, true);
  const receipt = (await pool.query(`SELECT status FROM ingest_receipts WHERE channel_id=$1 AND ingest_id=$2`, [ch.id, meta.ingest_id])).rows[0];
  assert.strictEqual(receipt.status, 'completed', 'receipt помечен completed');
  assert.ok((await db.getChannelHistoryInternal(ch.id, 30)).some((r) => r.day === today && r.subscribers === 100), 'daily записан');

  // повтор с тем же ingest_id + payload_hash → идемпотентный дубль, без второго прогона
  const r2 = await db.ingestCollectorPayload(ch.id, meta, data);
  assert.strictEqual(r2.duplicate, true, 'повтор распознан как дубль');
  const cnt = (await pool.query(`SELECT count(*)::int n FROM channel_daily WHERE channel_id=$1 AND day=$2`, [ch.id, today])).rows[0].n;
  assert.strictEqual(cnt, 1, 'дневная строка не задвоилась');
});

test('ingestCollectorPayload: тот же ingest_id с ДРУГИМ payload_hash → INGEST_ID_CONFLICT', { skip }, async () => {
  const ch = await mkChannel('confl');
  const meta = { ingest_id: ingId(), schema_version: '1', collector_version: '1.0', collected_at: new Date().toISOString(), payload_hash: 'hA' };
  const data = { snapshot: { s: 1 }, dailyRows: [], postRows: [], mentions: [], velocity: null, tgChannelId: null };
  await db.ingestCollectorPayload(ch.id, meta, data);
  await assert.rejects(
    () => db.ingestCollectorPayload(ch.id, { ...meta, payload_hash: 'hB' }, data),
    (e) => e.code === 'INGEST_ID_CONFLICT',
    'другой payload под тем же ingest_id — конфликт');
});

test('upsertChannelDaily: COALESCE-идемпотентность — NULL не затирает, обновление применяется', { skip }, async () => {
  const ch = await mkChannel('coal');
  await db.upsertChannelDaily(ch.id, [{ day: today, subscribers: 100, joins: 0, leaves: 0, views: 50, forwards: 0, reactions: 0 }]);
  // повторный прогон: subscribers=NULL (метрика временно недоступна) не должен затереть 100; views=75 обновляет
  await db.upsertChannelDaily(ch.id, [{ day: today, subscribers: null, joins: null, leaves: null, views: 75, forwards: null, reactions: null }]);
  const row = (await db.getChannelHistoryInternal(ch.id, 30)).find((r) => r.day === today);
  assert.strictEqual(row.subscribers, 100, 'NULL не затёр сохранённое значение');
  assert.strictEqual(row.views, 75, 'ненулевое значение обновилось');
});

test('persistCentralDaily: атомарный бандл daily+posts+velocity', { skip }, async () => {
  const ch = await mkChannel('pcd');
  const out = await db.persistCentralDaily(ch.id, {
    dailyRows: [{ day: today, subscribers: 500, joins: 0, leaves: 0, views: 0, forwards: 0, reactions: 0 }],
    postRows: [],
    velocity: { available: true, p50: 2.0 },
  });
  assert.strictEqual(out.channel_daily, 1);
  assert.strictEqual(out.velocity, true);
  assert.ok((await db.getChannelHistoryInternal(ch.id, 30)).some((r) => r.subscribers === 500));
  assert.ok(await db.getLatestVelocityInternal(ch.id), 'velocity записана');
});

test('upsertIgDaily roundtrip + saveRawSnapshot/pruneRawSnapshots', { skip }, async () => {
  const ch = await mkChannel('igraw');
  await db.upsertIgDaily(ch.id, [{ day: today, followers: 1000, reach: 5000, views: 8000 }]);
  assert.ok((await db.listIgDailyInternal(ch.id, 30)).some((r) => Number(r.followers) === 1000), 'ig_daily записан');

  assert.strictEqual(await db.saveRawSnapshot(ch.id, 'tg', 'graphs', today, { raw: 1 }), true);
  assert.strictEqual(await db.saveRawSnapshot(ch.id, 'tg', 'graphs', null, null), false, 'пустой payload не пишется');
  // prune с горизонтом 0 дней подрежет сегодняшний (day < CURRENT_DATE-0 → строго меньше сегодня: НЕ подрежет)
  const pruned = await db.pruneRawSnapshots(3650);
  assert.ok(typeof pruned === 'number', 'prune вернул число удалённых');
});
