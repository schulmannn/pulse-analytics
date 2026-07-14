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

test('getMentionsArchive: period scope + previous equal window + source isolation + ISO daily/source_options', { skip }, async () => {
  const { ch } = await chWithSource('menp', extId());
  // channel 555 (SMM) — 2 в текущем окне (250 + 50), 1 в предыдущем (400); channel 777 (Blog) — 1
  // в текущем (100); 1 очень старое (вне обоих окон, только в архиве).
  await pool.query(
    `INSERT INTO mentions (owner_channel_id, channel_id, msg_id, title, username, link, snippet, views, post_date) VALUES
      ($1, 555, 1, 'SMM', 'smm', 'http://a', 'сегодня', 250, now()),
      ($1, 555, 2, 'SMM', 'smm', 'http://b', 'на днях', 50,  now() - interval '5 days'),
      ($1, 777, 3, 'Blog','blog','http://c', 'блог',    100, now() - interval '2 days'),
      ($1, 555, 4, 'SMM', 'smm', 'http://d', 'прошлое', 400, now() - interval '40 days'),
      ($1, 555, 5, 'SMM', 'smm', 'http://e', 'давно',   999, now() - interval '200 days')`,
    [ch.id]);

  const cur = await db.getMentionsArchiveInternal(ch.id, { days: 30 });
  assert.strictEqual(cur.total, 3, 'текущее 30-дн окно: 3 упоминания');
  assert.strictEqual(cur.total_views, 400, 'сумма просмотров текущего окна (250+50+100)');
  assert.strictEqual(cur.unique_channels, 2, 'два канала в текущем окне');
  assert.ok(cur.previous, 'previous summary присутствует для 30');
  assert.strictEqual(cur.previous.total, 1, 'предыдущее равное окно: 1 упоминание');
  assert.strictEqual(cur.previous.total_views, 400, 'просмотры предыдущего окна');
  assert.ok(Array.isArray(cur.daily) && cur.daily.length >= 1, 'ISO daily массив непустой');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(cur.daily[0].day), 'daily.day в формате YYYY-MM-DD');
  assert.strictEqual(cur.source_options.length, 2, 'source_options за период (до фильтра) — 2 канала');
  assert.ok(cur.source_options.every((o) => typeof o.channel_id === 'string'), 'channel_id строкой');
  assert.deepStrictEqual(cur.source_summary, {
    total: 3,
    unique_channels: 2,
    total_views: 400,
  }, 'source_summary — точный unfiltered denominator до LIMIT/source filter');
  assert.match(cur.scope.current_from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(cur.scope.current_to, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(cur.scope.previous_from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(cur.scope.previous_to, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(cur.scope.daily_days, 30);
  assert.ok(cur.archive_total >= 5, 'archive_total — весь архив, включая вне окна');

  // source-фильтр сужает агрегаты, но НЕ трогает source_options (лидерборд не исчезает).
  const scoped = await db.getMentionsArchiveInternal(ch.id, { days: 30, source: '555' });
  assert.strictEqual(scoped.total, 2, 'source=555: 2 упоминания в текущем окне');
  assert.strictEqual(scoped.total_views, 300, 'source=555: просмотры 250+50');
  assert.strictEqual(scoped.unique_channels, 1, 'source=555: один канал');
  assert.strictEqual(scoped.source_options.length, 2, 'source_options остаются полными при выбранном source');
  assert.deepStrictEqual(scoped.source_summary, cur.source_summary, 'unfiltered denominator не меняется от source filter');

  // all-time (days=0): без previous, весь архив.
  const all = await db.getMentionsArchiveInternal(ch.id, { days: 0 });
  assert.strictEqual(all.total, 5, 'all-time: все 5 упоминаний');
  assert.strictEqual(all.previous, null, 'all-time: сравнения нет');

  // Backwards-compat: числовой второй аргумент = legacy limit (days=0).
  const legacy = await db.getMentionsArchiveInternal(ch.id, 2);
  assert.strictEqual(legacy.total, 5, 'legacy числовой limit → days=0');
  assert.strictEqual(legacy.recent.length, 2, 'legacy limit ограничивает recent');
});

test('getMentionsArchive: 30-day calendar boundaries do not overlap or drop an edge day', { skip }, async () => {
  const { ch } = await chWithSource('menb', extId());
  await pool.query(
    `INSERT INTO mentions (owner_channel_id, channel_id, msg_id, views, post_date) VALUES
      ($1, 901, 1, 10, CURRENT_DATE - 29),
      ($1, 901, 2, 20, CURRENT_DATE - 30),
      ($1, 901, 3, 30, CURRENT_DATE - 59),
      ($1, 901, 4, 40, CURRENT_DATE - 60)`,
    [ch.id]);

  const data = await db.getMentionsArchiveInternal(ch.id, { days: 30 });
  assert.strictEqual(data.total, 1, 'current includes day -29 only');
  assert.strictEqual(data.total_views, 10);
  assert.strictEqual(data.previous.total, 2, 'previous includes both -30 and -59');
  assert.strictEqual(data.previous.total_views, 50);
  assert.strictEqual(data.archive_total, 4, 'day -60 remains archive-only');
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
