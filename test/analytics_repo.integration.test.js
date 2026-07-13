'use strict';

// Integration-тесты analyticsRepo (P2 db-split PR 6) — на РЕАЛЬНОМ Postgres. Read-модели графиков.
// Ключевое: canonical source-union getChannelHistory/getLatestVelocity ДОЛЖНЫ оставаться в границе
// воркспейса читателя (sameTenantSource, ADR-001 F1) — тест это подтверждает после переноса. Seed
// через db-write-пути (upsertChannelDaily/saveSnapshot/saveVelocity/upsertIgDaily), чтение — через
// analytics-репо. Без TEST_DATABASE_URL всё SKIP.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `anl${Date.now().toString(36)}${process.pid}`;
let seq = 0;
const mail = (tag) => `${tag}.${seq++}.${nonce}@it.local`;
let extSeq = 0;
const usedExt = [];
const extId = () => { const v = `991${(process.pid % 100000)}${extSeq++}`; usedExt.push(v); return v; };
const today = new Date().toISOString().slice(0, 10);

const mkUser = (tag) => db.createUser({ email: mail(tag), pass_hash: 'x', role: 'user', status: 'active' });

// Канал владельца + застолблённый source_id (общий external identity для union-сценария).
async function chWithSource(tag, ext) {
  const u = await mkUser(tag);
  const ch = await db.createChannel({ owner_uid: u.id, username: `c.${tag}.${nonce}` });
  const srcId = await db.ensureExternalSource('tg', ext, { username: `src.${nonce}` });
  await pool.query(`UPDATE channels SET source_id=$1 WHERE id=$2`, [srcId, ch.id]);
  return { u, ch, srcId };
}

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM mentions WHERE owner_channel_id IN (SELECT id FROM channels WHERE owner_uid IN (SELECT id FROM users WHERE email LIKE $1))`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM external_sources WHERE username LIKE $1 OR external_id = ANY($2)`, [`%${nonce}%`, usedExt]);
  await pool.end();
});

test('getChannelHistory: канал видит свои дневные строки (day/subscribers/views)', { skip }, async () => {
  const { ch } = await chWithSource('h', extId());
  await db.upsertChannelDaily(ch.id, [{ day: today, subscribers: 100, joins: 5, leaves: 1, views: 200, forwards: 3, reactions: 7 }]);
  const hist = await db.getChannelHistoryInternal(ch.id, 30);
  const row = hist.find((r) => r.day === today);
  assert.ok(row, 'сегодняшняя строка вернулась');
  assert.strictEqual(row.subscribers, 100);
  assert.strictEqual(row.views, 200);
});

test('canonical union: со-фоллоу того же source В ТОМ ЖЕ воркспейсе видит строки соседа', { skip }, async () => {
  const ext = extId();
  const { u, ch: chA1 } = await chWithSource('u1', ext);
  // второй канал ТОГО ЖЕ владельца (тот же личный воркспейс), тот же source
  const chA2 = await db.createChannel({ owner_uid: u.id, username: `u1b.${nonce}` });
  await pool.query(`UPDATE channels SET source_id=(SELECT source_id FROM channels WHERE id=$1) WHERE id=$2`, [chA1.id, chA2.id]);
  await db.upsertChannelDaily(chA1.id, [{ day: today, subscribers: 500, joins: 0, leaves: 0, views: 0, forwards: 0, reactions: 0 }]);
  const hist = await db.getChannelHistoryInternal(chA2.id, 30);
  assert.ok(hist.some((r) => r.day === today && r.subscribers === 500), 'source-union отдал строку соседа в том же воркспейсе');
});

test('tenant isolation: тот же source в ДРУГОМ воркспейсе НЕ видит чужие строки (sameTenantSource)', { skip }, async () => {
  const ext = extId();
  const { ch: chA } = await chWithSource('iso-a', ext);            // владелец A, воркспейс A
  const { ch: chB } = await chWithSource('iso-b', ext);            // владелец B, воркспейс B, ТОТ ЖЕ source
  await db.upsertChannelDaily(chA.id, [{ day: today, subscribers: 777, joins: 0, leaves: 0, views: 0, forwards: 0, reactions: 0 }]);
  const histB = await db.getChannelHistoryInternal(chB.id, 30);
  assert.ok(!histB.some((r) => r.subscribers === 777), 'чужой воркспейс НЕ получает строки другого тенанта через source-union');
});

test('getSnapshot: roundtrip после saveSnapshot', { skip }, async () => {
  const { ch } = await chWithSource('snap', extId());
  await db.saveSnapshot(ch.id, { hello: 'world', n: 42 });
  const snap = await db.getSnapshotInternal(ch.id);
  assert.deepStrictEqual(snap.data, { hello: 'world', n: 42 });
  assert.ok(snap.updated_at, 'updated_at проставлен');
});

test('getLatestVelocity: roundtrip после saveVelocity', { skip }, async () => {
  const { ch } = await chWithSource('vel', extId());
  await db.saveVelocity(ch.id, { p50: 1.5, p90: 3.2 });
  const v = await db.getLatestVelocityInternal(ch.id);
  assert.deepStrictEqual(v.data, { p50: 1.5, p90: 3.2 });
});

test('listPostsForActor: archive has the live-post shape and remains actor-gated', { skip }, async () => {
  const { u: owner, ch } = await chWithSource('posts', extId());
  const stranger = await mkUser('posts-x');
  const postId = Number(`8${Date.now().toString().slice(-10)}`);
  await db.upsertPosts(ch.id, [{
    post_id: postId,
    date_published: '2026-07-12T10:00:00Z',
    views: 900,
    reactions: 40,
    forwards: 7,
    replies: 3,
    erv: 5.5,
    virality: 0.7,
    media_type: 'photo',
    caption: 'Archived caption',
    hashtags: ['archive'],
  }]);

  const rows = await db.listPostsForActor(ch.id, { uid: owner.id }, 10);
  const row = rows.find((item) => Number(item.id) === postId);
  assert.ok(row, 'owner receives the archived post');
  assert.equal(row.text, 'Archived caption');
  assert.equal(row.views, 900);
  assert.deepStrictEqual(row.hashtags, ['archive']);
  assert.deepStrictEqual(
    await db.listPostsForActor(ch.id, { uid: stranger.id }, 10),
    [],
    'an actor without channel access receives no posts',
  );
});

test('listIgDaily: roundtrip после upsertIgDaily', { skip }, async () => {
  const { ch } = await chWithSource('ig', extId());
  await db.upsertIgDaily(ch.id, [{ day: today, followers: 1000, reach: 5000, views: 8000, likes: 300 }]);
  const rows = await db.listIgDailyInternal(ch.id, 30);
  const r = rows.find((x) => x.day === today);
  assert.ok(r, 'ig_daily строка вернулась');
  assert.strictEqual(Number(r.followers), 1000);
  assert.strictEqual(Number(r.reach), 5000);
});

test('getMentionsArchive/History: сводка и панель из архива (скоуп по owner_channel_id)', { skip }, async () => {
  const { ch } = await chWithSource('men', extId());
  await pool.query(
    `INSERT INTO mentions (owner_channel_id, channel_id, msg_id, title, username, link, snippet, views, post_date)
     VALUES ($1, 555, 1, 'Chan', 'chan', 'http://x', 'hi', 250, now()),
            ($1, 555, 2, 'Chan', 'chan', 'http://y', 'yo', 100, now())`, [ch.id]);
  const arch = await db.getMentionsArchiveInternal(ch.id, 30);
  assert.strictEqual(arch.available, true);
  assert.strictEqual(arch.total, 2, 'две упоминания в архиве');
  assert.strictEqual(arch.total_views, 350, 'сумма просмотров (number, не строка)');
  assert.ok(arch.recent.length === 2 && arch.recent[0].views != null);
  const hist = await db.getMentionsHistoryInternal(ch.id);
  assert.strictEqual(hist.total.total, 2);
});

test('finding 5 — ForActor gate: владелец видит данные, чужой actor → пусто (репо форсит доступ сам)', { skip }, async () => {
  const { u: owner, ch } = await chWithSource('fa', extId());
  const stranger = await mkUser('fa-x');
  await db.upsertChannelDaily(ch.id, [{ day: today, subscribers: 321, joins: 0, leaves: 0, views: 0, forwards: 0, reactions: 0 }]);
  await db.saveSnapshot(ch.id, { s: 1 });
  await db.saveVelocity(ch.id, { v: 2 });
  await db.upsertIgDaily(ch.id, [{ day: today, followers: 9, reach: 0, views: 0 }]);

  // владелец (actor с доступом) — реальные данные
  assert.ok((await db.getChannelHistoryForActor(ch.id, { uid: owner.id }, 30)).some((r) => r.subscribers === 321), 'владелец видит историю');
  assert.ok(await db.getSnapshotForActor(ch.id, { uid: owner.id }), 'владелец видит снапшот');
  assert.ok(await db.getLatestVelocityForActor(ch.id, { uid: owner.id }), 'владелец видит velocity');
  assert.strictEqual((await db.listIgDailyForActor(ch.id, { uid: owner.id }, 30)).length, 1, 'владелец видит ig-daily');

  // чужой actor — ПУСТО, даже без route-middleware: репо гейтит доступ сам (finding 5)
  assert.deepStrictEqual(await db.getChannelHistoryForActor(ch.id, { uid: stranger.id }, 30), [], 'чужой → [] (история)');
  assert.strictEqual(await db.getSnapshotForActor(ch.id, { uid: stranger.id }), null, 'чужой → null (снапшот)');
  assert.strictEqual(await db.getLatestVelocityForActor(ch.id, { uid: stranger.id }), null, 'чужой → null (velocity)');
  assert.deepStrictEqual(await db.listIgDailyForActor(ch.id, { uid: stranger.id }, 30), [], 'чужой → [] (ig-daily)');
  assert.strictEqual(await db.getMentionsArchiveForActor(ch.id, { uid: stranger.id }), null, 'чужой → null (mentions-архив)');
  assert.deepStrictEqual(await db.getChannelHistoryForActor(ch.id, {}, 30), [], 'без uid → []');
});
