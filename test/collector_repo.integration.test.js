'use strict';

// Integration-тесты collectorRepo (P2 db-split PR 7) — на РЕАЛЬНОМ Postgres. Приём/запись данных
// collector'а: ИДЕМПОТЕНТНОСТЬ (повтор ingest_id безопасен, конфликт payload → ошибка), COALESCE-
// upsert (NULL не затирает), pure graphsToDailyRows, persist-бандлы, ретеншн. Без TEST_DATABASE_URL SKIP.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

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
  db = createTestDatabase(TEST_DB);
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

test('persistTgBundleTx: velocity сохраняется АТОМАРНО со снапшотом/daily + идемпотентно за день', { skip }, async () => {
  const ch = await mkChannel('ptbvel');
  const out = await db.persistTgBundleTx(ch.id, {
    snapshot: { s: 1 },
    dailyRows: [{ day: today, subscribers: 300, joins: 0, leaves: 0, views: 0, forwards: 0, reactions: 0 }],
    postRows: [],
    velocity: { available: true, day1_share: 40, posts_used: 5 },
  });
  assert.strictEqual(out.channel_daily, 1);
  assert.strictEqual(out.velocity, true, 'available velocity → сохранена и посчитана');
  assert.ok(await db.getLatestVelocityInternal(ch.id), 'velocity записана в той же транзакции');
  assert.ok((await db.getChannelHistoryInternal(ch.id, 30)).some((r) => r.subscribers === 300), 'daily записан');

  // Повтор того же дня перезаписывает строку (ON CONFLICT channel_id, day), не дублирует.
  const out2 = await db.persistTgBundleTx(ch.id, {
    snapshot: { s: 2 }, dailyRows: [], postRows: [], velocity: { available: true, day1_share: 55, posts_used: 6 },
  });
  assert.strictEqual(out2.velocity, true);
  const cnt = (await pool.query(`SELECT count(*)::int n FROM velocity_daily WHERE channel_id=$1 AND day=CURRENT_DATE`, [ch.id])).rows[0].n;
  assert.strictEqual(cnt, 1, 'velocity_daily за день не задвоилась');
});

test('persistTgBundleTx: недоступная velocity (available:false) НЕ пишется, velocity=false', { skip }, async () => {
  const ch = await mkChannel('ptbnovel');
  const out = await db.persistTgBundleTx(ch.id, {
    snapshot: { s: 1 }, dailyRows: [], postRows: [], velocity: { available: false, posts_used: 0 },
  });
  assert.strictEqual(out.velocity, false, 'available:false никогда не отмечается как успех');
  assert.strictEqual(!!(await db.getLatestVelocityInternal(ch.id)), false, 'строка velocity_daily не появилась');
});

test('persistTgBundleTx: velocity=null (обычный QR) → бандл пишется, velocity не трогается', { skip }, async () => {
  const ch = await mkChannel('ptbnull');
  const out = await db.persistTgBundleTx(ch.id, {
    snapshot: { s: 1 },
    dailyRows: [{ day: today, subscribers: 111, joins: 0, leaves: 0, views: 0, forwards: 0, reactions: 0 }],
    postRows: [],
    // velocity опущена (default null) — обратная совместимость: обычный QR-канал velocity не шлёт.
  });
  assert.strictEqual(out.channel_daily, 1);
  assert.strictEqual(out.velocity, false);
  assert.strictEqual(!!(await db.getLatestVelocityInternal(ch.id)), false);
});

test('persistTgBundleTx: сбой внутри бандла откатывает ВСЁ — velocity не «протекает» (атомарность)', { skip }, async () => {
  const ch = await mkChannel('ptbrb');
  await assert.rejects(() => db.persistTgBundleTx(ch.id, {
    snapshot: { s: 1 },
    dailyRows: [{ day: today, subscribers: 100, joins: 0, leaves: 0, views: 0, forwards: 0, reactions: 0 }],
    // Невалидный post_id (bigint-каст падает) роняет upsertPosts ПОСЛЕ снапшота/daily → ROLLBACK всего.
    postRows: [{ post_id: 'not-a-bigint', date_published: today, views: 1 }],
    velocity: { available: true, day1_share: 40 },
  }));
  assert.strictEqual(!!(await db.getLatestVelocityInternal(ch.id)), false, 'откат: velocity не записана');
  assert.strictEqual((await db.getChannelHistoryInternal(ch.id, 30)).length, 0, 'откат: daily не записан');
});

test('post media (covers): upsert хранит JPEG как bytea; getPostMedia читает с sm-fallback и идемпотентен', { skip }, async () => {
  const ch = await mkChannel('media');
  await db.upsertPosts(ch.id, [{
    post_id: 1241, date_published: today, views: 10, reactions: 1, forwards: 0, replies: 0,
    erv: null, virality: null, media_type: 'photo', caption: 'x', hashtags: [],
  }]);
  const jpegSm = Buffer.from([0xff, 0xd8, 0xaa, 0xbb]);
  const n = await db.upsertPostMedia(ch.id, [{ post_id: 1241, size: 'sm', jpeg_b64: jpegSm.toString('base64') }]);
  assert.strictEqual(n, 1);

  const got = await db.getPostMedia(ch.id, 1241, 'sm');
  assert.ok(Buffer.isBuffer(got), 'bytea читается как Buffer');
  assert.deepStrictEqual(Buffer.from(got), jpegSm, 'байты round-trip через base64/bytea');

  // ?size=lg при сохранённом только sm → отдаём sm (видимая обложка, не промах)
  assert.deepStrictEqual(Buffer.from(await db.getPostMedia(ch.id, 1241, 'lg')), jpegSm);

  // повторный collect перезаписывает те же байты, а не дублирует строку
  const jpeg2 = Buffer.from([0xff, 0xd8, 0xcc, 0xdd]);
  await db.upsertPostMedia(ch.id, [{ post_id: 1241, size: 'sm', jpeg_b64: jpeg2.toString('base64') }]);
  assert.deepStrictEqual(Buffer.from(await db.getPostMedia(ch.id, 1241, 'sm')), jpeg2);
  const cnt = (await pool.query(`SELECT count(*)::int n FROM tg_post_media WHERE channel_id=$1 AND post_id=$2`, [ch.id, 1241])).rows[0].n;
  assert.strictEqual(cnt, 1, 'upsert по (channel,post,size) не задваивает');

  // неизвестный пост → null (прокси уходит в live-fallback); строки без jpeg_b64 игнорируются
  assert.strictEqual(await db.getPostMedia(ch.id, 9999, 'sm'), null);
  assert.strictEqual(await db.upsertPostMedia(ch.id, [{ post_id: 7, size: 'sm' }]), 0);
  assert.strictEqual(await db.upsertPostMedia(ch.id, [{ post_id: 1241, size: 'bad', jpeg_b64: jpegSm.toString('base64') }]), 0);
  assert.strictEqual(await db.upsertPostMedia(ch.id, [{ post_id: 1241, size: 'sm', jpeg_b64: Buffer.from('not-jpeg').toString('base64') }]), 0);

  // Media lifecycle follows the posts archive, so future post retention cannot orphan blobs.
  await pool.query(`DELETE FROM posts WHERE channel_id=$1 AND post_id=$2`, [ch.id, 1241]);
  assert.strictEqual(await db.getPostMedia(ch.id, 1241, 'sm'), null, 'post delete cascades to its cover');
});

test('listCentralPostsMissingMedia: bounded recent photo/video posts missing an sm cover; decimal-string ids', { skip }, async () => {
  const ch = await mkChannel('missmedia');
  const recent = new Date().toISOString();
  const aged = new Date(Date.now() - 400 * 864e5).toISOString();   // far older than the window
  await db.upsertPosts(ch.id, [
    { post_id: 1306, date_published: recent, media_type: 'photo', caption: 'a', hashtags: [] },
    { post_id: 1312, date_published: recent, media_type: 'video', caption: 'b', hashtags: [] },
    { post_id: 1400, date_published: recent, media_type: 'text',  caption: 'c', hashtags: [] },  // not a cover type
    { post_id: 1307, date_published: recent, media_type: 'photo', caption: 'd', hashtags: [] },  // will get a cover
    { post_id: 999,  date_published: aged,   media_type: 'photo', caption: 'e', hashtags: [] },  // aged out
  ]);
  // 1307 already has a stored small cover → it must NOT appear in the missing set.
  await db.upsertPostMedia(ch.id, [{ post_id: 1307, size: 'sm', jpeg_b64: Buffer.from([0xff, 0xd8, 0x1, 0x2]).toString('base64') }]);

  const rows = await db.listCentralPostsMissingMedia(ch.id, { limit: 10, windowDays: 21 });
  const ids = rows.map((r) => r.post_id);
  assert.ok(ids.includes('1306') && ids.includes('1312'), 'recent photo+video without a cover are eligible');
  assert.ok(!ids.includes('1307'), 'a post whose sm cover exists is excluded (drops out permanently once filled)');
  assert.ok(!ids.includes('1400'), 'non photo/video posts are never asked for a cover');
  assert.ok(!ids.includes('999'), 'a post older than the window ages out instead of being retried forever');
  assert.strictEqual(typeof ids[0], 'string', 'post_id returned as a decimal STRING (BIGINT-safe), never a JS Number');
});

test('listCentralPostsMissingMedia: batch prioritizes product-visible top gaps and rotates the archive half', { skip }, async () => {
  const ch = await mkChannel('missmedialim');
  const posts = Array.from({ length: 10 }, (_, index) => ({
    post_id: (index + 1) * 10,
    date_published: new Date(Date.now() - (10 - index) * 864e5).toISOString(),
    media_type: 'photo',
    views: (index + 1) * 100,
    reactions: index < 3 ? 1000 - index * 100 : index,
    forwards: index < 3 ? 100 - index * 10 : 0,
    replies: index < 3 ? 10 - index : 0,
    hashtags: [],
  }));
  await db.upsertPosts(ch.id, posts);
  const opts = { limit: 6, windowDays: 21, seed: 'bucket-42' };
  const rows = await db.listCentralPostsMissingMedia(ch.id, opts);
  const repeat = await db.listCentralPostsMissingMedia(ch.id, opts);
  assert.equal(rows.length, 6, 'bounded by LIMIT');
  assert.deepStrictEqual(repeat, rows, 'same durable bucket seed produces the same batch');
  assert.deepStrictEqual(rows.slice(0, 3).map((row) => row.post_id), ['10', '20', '30'],
    'product half follows engagement first even when those posts are older and have fewer views');
  assert.ok(rows.slice(3).every((row) => !['10', '20', '30'].includes(row.post_id)),
    'archive half is drawn from the remaining gaps instead of duplicating the product-priority lane');
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
